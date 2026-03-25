import net from 'net';
import { EventEmitter } from 'events';
import { validateC0, generateS0S1S2 } from './handshake.js';
import { parseChunkHeader, MSG_TYPE_AUDIO, MSG_TYPE_VIDEO, MSG_TYPE_COMMAND_AMF0 } from './chunk-parser.js';
import { decodeAMF0Multiple } from './amf0.js';

const DEFAULT_CHUNK_SIZE = 128;

type ConnectionState = 'WAITING_C0C1' | 'WAITING_C2' | 'READY';

interface MessageBuffer {
  messageTypeId: number;
  messageLength: number;
  data: Buffer;
}

function handleConnection(socket: net.Socket, emitter: EventEmitter): void {
  let state: ConnectionState = 'WAITING_C0C1';
  let recvBuf = Buffer.alloc(0);
  const messageBuffers = new Map<number, MessageBuffer>();

  socket.on('data', (chunk: Buffer) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    processBuffer();
  });

  socket.on('close', () => {
    emitter.emit('disconnect');
  });

  socket.on('error', () => {
    emitter.emit('disconnect');
  });

  function processBuffer(): void {
    let consumed = true;
    while (consumed) {
      consumed = false;

      if (state === 'WAITING_C0C1') {
        if (recvBuf.length >= 1537) {
          const c0 = recvBuf.subarray(0, 1);
          const c1 = recvBuf.subarray(1, 1537);
          recvBuf = recvBuf.subarray(1537);

          if (!validateC0(c0)) {
            socket.destroy();
            return;
          }

          const s0s1s2 = generateS0S1S2(c1);
          socket.write(s0s1s2);
          state = 'WAITING_C2';
          consumed = true;
        }
      } else if (state === 'WAITING_C2') {
        if (recvBuf.length >= 1536) {
          // C2 폐기
          recvBuf = recvBuf.subarray(1536);
          state = 'READY';
          emitter.emit('connection');
          consumed = true;
        }
      } else if (state === 'READY') {
        if (recvBuf.length < 1) break;

        let headerResult;
        try {
          headerResult = parseChunkHeader(recvBuf);
        } catch {
          break;
        }

        const { fmt, csid, headerSize } = headerResult;

        if (recvBuf.length < headerSize) break;

        const chunkPayloadSize = DEFAULT_CHUNK_SIZE;

        if (fmt === 0) {
          const { messageLength, messageTypeId } = headerResult;
          if (messageLength === undefined || messageTypeId === undefined) break;

          const payloadSize = Math.min(messageLength, chunkPayloadSize);
          if (recvBuf.length < headerSize + payloadSize) break;

          const payload = recvBuf.subarray(headerSize, headerSize + payloadSize);
          recvBuf = recvBuf.subarray(headerSize + payloadSize);

          if (messageLength <= chunkPayloadSize) {
            // 한 청크로 완성된 메시지
            dispatchMessage(messageTypeId, payload);
          } else {
            // 다중 청크 메시지 조립 시작
            messageBuffers.set(csid, {
              messageTypeId,
              messageLength,
              data: Buffer.from(payload),
            });
          }
          consumed = true;
        } else if (fmt === 3) {
          const existing = messageBuffers.get(csid);
          if (!existing) break;

          const remaining = existing.messageLength - existing.data.length;
          const payloadSize = Math.min(remaining, chunkPayloadSize);
          if (recvBuf.length < headerSize + payloadSize) break;

          const payload = recvBuf.subarray(headerSize, headerSize + payloadSize);
          recvBuf = recvBuf.subarray(headerSize + payloadSize);

          existing.data = Buffer.concat([existing.data, payload]);

          if (existing.data.length >= existing.messageLength) {
            dispatchMessage(existing.messageTypeId, existing.data);
            messageBuffers.delete(csid);
          }
          consumed = true;
        } else if (fmt === 1 || fmt === 2) {
          // 최소 서브셋: 타입 0처럼 처리하되 타임스탬프 델타 사용
          const { messageLength, messageTypeId } = headerResult;
          if (fmt === 1 && messageLength !== undefined && messageTypeId !== undefined) {
            const payloadSize = Math.min(messageLength, chunkPayloadSize);
            if (recvBuf.length < headerSize + payloadSize) break;

            const payload = recvBuf.subarray(headerSize, headerSize + payloadSize);
            recvBuf = recvBuf.subarray(headerSize + payloadSize);

            if (messageLength <= chunkPayloadSize) {
              dispatchMessage(messageTypeId, payload);
            } else {
              messageBuffers.set(csid, {
                messageTypeId,
                messageLength,
                data: Buffer.from(payload),
              });
            }
            consumed = true;
          } else if (fmt === 2) {
            // 타입 2: 타임스탬프 델타만, 기존 csid 상태 사용
            const existing = messageBuffers.get(csid);
            if (!existing) break;
            const remaining = existing.messageLength - existing.data.length;
            const payloadSize = Math.min(remaining, chunkPayloadSize);
            if (recvBuf.length < headerSize + payloadSize) break;
            const payload = recvBuf.subarray(headerSize, headerSize + payloadSize);
            recvBuf = recvBuf.subarray(headerSize + payloadSize);
            existing.data = Buffer.concat([existing.data, payload]);
            if (existing.data.length >= existing.messageLength) {
              dispatchMessage(existing.messageTypeId, existing.data);
              messageBuffers.delete(csid);
            }
            consumed = true;
          }
        }
      }
    }
  }

  function dispatchMessage(messageTypeId: number, payload: Buffer): void {
    if (messageTypeId === MSG_TYPE_VIDEO) {
      emitter.emit('videoData', payload);
    } else if (messageTypeId === MSG_TYPE_AUDIO) {
      emitter.emit('audioData', payload);
    } else if (messageTypeId === MSG_TYPE_COMMAND_AMF0) {
      try {
        const args = decodeAMF0Multiple(payload);
        emitter.emit('command', args);
      } catch {
        // 잘못된 AMF0 무시
      }
    }
  }
}

export class RTMPServer extends EventEmitter {
  private server: net.Server | null = null;

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        handleConnection(socket, this);
      });

      this.server.on('error', reject);

      this.server.listen(port, () => {
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
