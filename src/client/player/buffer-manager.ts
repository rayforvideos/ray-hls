const BUFFER_AHEAD = 30;  // seconds
const BUFFER_BEHIND = 10; // seconds

interface QueueItem {
  data: Uint8Array;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Convert a Uint8Array to an ArrayBuffer copy that satisfies the
 * BufferSource type expected by SourceBuffer.appendBuffer() in strict TS.
 */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Manages MSE SourceBuffers with queue-based appending to avoid
 * concurrent updates, and automatic cleanup of old buffered data.
 */
export class BufferManager {
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;
  private videoQueue: QueueItem[] = [];
  private audioQueue: QueueItem[] = [];
  private videoUpdating = false;
  private audioUpdating = false;

  attach(videoBuffer: SourceBuffer, audioBuffer: SourceBuffer): void {
    this.videoBuffer = videoBuffer;
    this.audioBuffer = audioBuffer;

    this.videoBuffer.addEventListener('updateend', () => {
      this.videoUpdating = false;
      this.processQueue(this.videoQueue, this.videoBuffer!);
    });

    this.audioBuffer.addEventListener('updateend', () => {
      this.audioUpdating = false;
      this.processQueue(this.audioQueue, this.audioBuffer!);
    });
  }

  async appendVideo(data: Uint8Array): Promise<void> {
    return this.enqueue(data, this.videoQueue, this.videoBuffer!, 'video');
  }

  async appendAudio(data: Uint8Array): Promise<void> {
    return this.enqueue(data, this.audioQueue, this.audioBuffer!, 'audio');
  }

  cleanup(currentTime: number): void {
    this.cleanupBuffer(this.videoBuffer, currentTime);
    this.cleanupBuffer(this.audioBuffer, currentTime);
  }

  getBufferedEnd(): number {
    let end = 0;
    if (this.videoBuffer && this.videoBuffer.buffered.length > 0) {
      end = Math.min(end || Infinity, this.videoBuffer.buffered.end(this.videoBuffer.buffered.length - 1));
    }
    if (this.audioBuffer && this.audioBuffer.buffered.length > 0) {
      end = Math.min(end, this.audioBuffer.buffered.end(this.audioBuffer.buffered.length - 1));
    }
    return end;
  }

  async waitForIdle(): Promise<void> {
    const waitFor = (sb: SourceBuffer | null) => {
      if (!sb || !sb.updating) return Promise.resolve();
      return new Promise<void>(resolve => {
        sb.addEventListener('updateend', () => resolve(), { once: true });
      });
    };
    await waitFor(this.videoBuffer);
    await waitFor(this.audioBuffer);
  }

  getBufferLevel(currentTime: number): number {
    if (!this.videoBuffer || this.videoBuffer.buffered.length === 0) {
      return 0;
    }
    for (let i = 0; i < this.videoBuffer.buffered.length; i++) {
      const start = this.videoBuffer.buffered.start(i);
      const end = this.videoBuffer.buffered.end(i);
      if (currentTime >= start && currentTime <= end) {
        return end - currentTime;
      }
    }
    return 0;
  }

  private enqueue(
    data: Uint8Array,
    queue: QueueItem[],
    buffer: SourceBuffer,
    type: 'video' | 'audio',
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      queue.push({ data, resolve, reject });
      const updating = type === 'video' ? this.videoUpdating : this.audioUpdating;
      if (!updating) {
        this.processQueue(queue, buffer);
      }
    });
  }

  private processQueue(queue: QueueItem[], buffer: SourceBuffer): void {
    if (queue.length === 0 || buffer.updating) {
      return;
    }

    const item = queue.shift()!;
    const isVideo = buffer === this.videoBuffer;

    if (isVideo) {
      this.videoUpdating = true;
    } else {
      this.audioUpdating = true;
    }

    const onUpdateEnd = (): void => {
      buffer.removeEventListener('updateend', onUpdateEnd);
      buffer.removeEventListener('error', onError);
      item.resolve();
    };

    const onError = (): void => {
      buffer.removeEventListener('updateend', onUpdateEnd);
      buffer.removeEventListener('error', onError);
      item.reject(new Error('SourceBuffer append error'));
    };

    buffer.addEventListener('updateend', onUpdateEnd);
    buffer.addEventListener('error', onError);

    try {
      buffer.appendBuffer(toArrayBuffer(item.data));
    } catch (err: unknown) {
      buffer.removeEventListener('updateend', onUpdateEnd);
      buffer.removeEventListener('error', onError);

      if (isVideo) {
        this.videoUpdating = false;
      } else {
        this.audioUpdating = false;
      }

      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        // Try to free space and retry once
        this.removeOldData(buffer, 0);
        try {
          buffer.addEventListener('updateend', onUpdateEnd);
          buffer.addEventListener('error', onError);
          if (isVideo) {
            this.videoUpdating = true;
          } else {
            this.audioUpdating = true;
          }
          buffer.appendBuffer(toArrayBuffer(item.data));
        } catch (retryErr) {
          buffer.removeEventListener('updateend', onUpdateEnd);
          buffer.removeEventListener('error', onError);
          if (isVideo) {
            this.videoUpdating = false;
          } else {
            this.audioUpdating = false;
          }
          item.reject(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
        }
      } else {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private cleanupBuffer(buffer: SourceBuffer | null, currentTime: number): void {
    if (!buffer || buffer.updating || buffer.buffered.length === 0) {
      return;
    }

    const removeEnd = currentTime - BUFFER_BEHIND;
    if (removeEnd > 0 && buffer.buffered.start(0) < removeEnd) {
      try {
        buffer.remove(buffer.buffered.start(0), removeEnd);
      } catch {
        // Ignore errors during cleanup
      }
    }
  }

  private removeOldData(buffer: SourceBuffer, currentTime: number): void {
    if (buffer.buffered.length === 0) return;
    const removeEnd = Math.max(currentTime - 1, buffer.buffered.start(0) + 1);
    try {
      buffer.remove(buffer.buffered.start(0), removeEnd);
    } catch {
      // Best effort
    }
  }
}
