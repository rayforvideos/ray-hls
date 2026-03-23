import { PlayerStateMachine, PlayerState } from './state-machine.js';
import { BufferManager } from './buffer-manager.js';
import { TSDemuxer } from '../demuxer/ts-demuxer.js';
import { generateInitSegment } from '../remuxer/init-segment.js';
import { generateMediaSegment } from '../remuxer/media-segment.js';
import { ABREngine } from '../abr/abr-engine.js';
import { PrefetchEngine } from '../prefetch/prefetch-engine.js';
import { QualityLevel, QUALITY_LEVELS, NAL_TYPE_SPS, NAL_TYPE_PPS } from '../../shared/types.js';
import { parseNALUnits } from '../demuxer/nal-parser.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const REBUFFER_THRESHOLD = 1; // seconds

export class HLSPlayer {
  private stateMachine = new PlayerStateMachine();
  private bufferManager = new BufferManager();
  private abrEngine: ABREngine | null = null;
  private prefetchEngine = new PrefetchEngine({ bufferTarget: 30 });
  private video: HTMLVideoElement;
  private mediaSource: MediaSource | null = null;
  private qualityLevels: QualityLevel[] = [];
  private baseUrl = '';
  private segmentIndex = 0;
  private videoBaseDecodeTime = 0;
  private audioBaseDecodeTime = 0;
  private sequenceNumber = 1;

  constructor(video: HTMLVideoElement) {
    this.video = video;

    // timeupdate handler: cleanup, ABR buffer level, rebuffering detection
    this.video.addEventListener('timeupdate', () => {
      const currentTime = this.video.currentTime;
      this.bufferManager.cleanup(currentTime);

      const bufferLevel = this.bufferManager.getBufferLevel(currentTime);
      if (this.abrEngine) {
        this.abrEngine.updateBufferLevel(bufferLevel);
      }

      if (
        this.stateMachine.state === 'PLAYING' &&
        bufferLevel < REBUFFER_THRESHOLD &&
        !this.video.paused &&
        !this.video.ended
      ) {
        this.stateMachine.transition('REBUFFERING');
      }
    });
  }

  get state(): PlayerState {
    return this.stateMachine.state;
  }

  get abr(): ABREngine {
    if (!this.abrEngine) {
      throw new Error('ABR engine not initialized — call load() first');
    }
    return this.abrEngine;
  }

  async load(masterPlaylistUrl: string): Promise<void> {
    // 1. Transition to LOADING_MANIFEST
    if (!this.stateMachine.transition('LOADING_MANIFEST')) {
      throw new Error('Cannot load: invalid state transition');
    }

    // 2. Fetch master playlist, parse quality levels
    const playlistText = await this.fetchText(masterPlaylistUrl);
    this.qualityLevels = this.parseMasterPlaylist(playlistText);
    if (this.qualityLevels.length === 0) {
      this.qualityLevels = [...QUALITY_LEVELS];
    }
    this.abrEngine = new ABREngine(this.qualityLevels);

    // Derive base URL from the master playlist URL
    const lastSlash = masterPlaylistUrl.lastIndexOf('/');
    this.baseUrl = lastSlash >= 0 ? masterPlaylistUrl.substring(0, lastSlash) : '';

    // 3. Create MediaSource, set video.src
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);

    // 4. Wait for 'sourceopen'
    await new Promise<void>((resolve) => {
      this.mediaSource!.addEventListener('sourceopen', () => resolve(), { once: true });
    });

    // 5. Add SourceBuffers
    const videoSourceBuffer = this.mediaSource.addSourceBuffer(
      'video/mp4; codecs="avc1.42c01e"',
    );
    const audioSourceBuffer = this.mediaSource.addSourceBuffer(
      'audio/mp4; codecs="mp4a.40.2"',
    );

    // 6. Attach to BufferManager
    this.bufferManager.attach(videoSourceBuffer, audioSourceBuffer);

    // 7. Transition to LOADING_INIT_SEGMENT
    this.stateMachine.transition('LOADING_INIT_SEGMENT');

    // 8. Fetch first segment, demux, extract SPS/PPS, generate and append init segments
    const quality = this.abrEngine.decide();
    const firstSegmentUrl = `${this.baseUrl}/${quality.name}/${quality.name}-seg-${this.segmentIndex}.ts`;
    const firstSegmentData = await this.fetchBinary(firstSegmentUrl);

    const demuxer = new TSDemuxer();
    const result = demuxer.demux(firstSegmentData);

    // Extract SPS and PPS from the first video sample
    let sps: Uint8Array | null = null;
    let pps: Uint8Array | null = null;
    for (const sample of result.videoSamples) {
      const nalUnits = parseNALUnits(sample.data);
      for (const nal of nalUnits) {
        if (nal.type === NAL_TYPE_SPS && !sps) {
          sps = nal.data;
        }
        if (nal.type === NAL_TYPE_PPS && !pps) {
          pps = nal.data;
        }
      }
      if (sps && pps) break;
    }

    if (!sps || !pps) {
      this.stateMachine.transition('ERROR');
      throw new Error('Could not find SPS/PPS in first segment');
    }

    // Determine audio parameters from first audio sample (AAC default: 44100Hz, 2ch)
    const audioSampleRate = 44100;
    const audioChannels = 2;

    const initOpts = {
      width: quality.width,
      height: quality.height,
      sps,
      pps,
      audioSampleRate,
      audioChannels,
    };

    // Generate SEPARATE init segments for video and audio
    const videoInitSegment = generateInitSegment({ ...initOpts, trackType: 'video' as const });
    const audioInitSegment = generateInitSegment({ ...initOpts, trackType: 'audio' as const });

    await this.bufferManager.appendVideo(videoInitSegment);
    await this.bufferManager.appendAudio(audioInitSegment);

    // Generate and append media segments for the first segment (separate video/audio)
    const videoMediaSegment = generateMediaSegment(
      this.sequenceNumber, result.videoSamples, [], this.videoBaseDecodeTime, 0,
    );
    const audioMediaSegment = generateMediaSegment(
      this.sequenceNumber, [], result.audioSamples, 0, this.audioBaseDecodeTime,
    );

    await this.bufferManager.appendVideo(videoMediaSegment);
    await this.bufferManager.appendAudio(audioMediaSegment);

    // Update baseDecodeTimes
    this.videoBaseDecodeTime += this.computeTotalDuration(result.videoSamples);
    this.audioBaseDecodeTime += this.computeTotalDuration(result.audioSamples);
    this.segmentIndex++;
    this.sequenceNumber++;

    // 9. Transition to BUFFERING -> PLAYING
    this.stateMachine.transition('BUFFERING');
    this.stateMachine.transition('PLAYING');
    this.video.play().catch(() => { /* autoplay may be blocked */ });

    // 10. Start loadLoop
    this.loadLoop();
  }

  // ---------------------------------------------------------------------------
  // Load loop
  // ---------------------------------------------------------------------------

  private async loadLoop(): Promise<void> {
    while (
      this.stateMachine.state === 'PLAYING' ||
      this.stateMachine.state === 'REBUFFERING'
    ) {
      // Check prefetch
      const bufferLevel = this.bufferManager.getBufferLevel(this.video.currentTime);
      const currentQuality = this.abrEngine!.decide();
      const prefetchDecision = this.prefetchEngine.shouldPrefetch({
        bufferLevel,
        bandwidth: 0, // bandwidth is tracked inside ABR engine
        currentQuality,
        nextSegmentIndex: this.segmentIndex,
      });

      if (!prefetchDecision.shouldFetch) {
        await this.sleep(1000);
        continue;
      }

      // Decide quality via ABR
      const quality = currentQuality;
      const segmentUrl = `${this.baseUrl}/${quality.name}/${quality.name}-seg-${this.segmentIndex}.ts`;

      let segmentData: Uint8Array | null = null;
      let downloadTimeMs = 0;
      let retryCount = 0;

      while (retryCount < MAX_RETRIES) {
        try {
          const startTime = performance.now();
          const response = await fetch(segmentUrl);

          if (response.status === 404) {
            // End of stream
            this.stateMachine.transition('ENDED');
            if (this.mediaSource && this.mediaSource.readyState === 'open') {
              this.mediaSource.endOfStream();
            }
            return;
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const buffer = await response.arrayBuffer();
          downloadTimeMs = performance.now() - startTime;
          segmentData = new Uint8Array(buffer);
          break;
        } catch (err) {
          retryCount++;
          if (retryCount >= MAX_RETRIES) {
            this.stateMachine.transition('ERROR');
            return;
          }
          await this.sleep(RETRY_DELAY_MS);
        }
      }

      if (!segmentData) {
        this.stateMachine.transition('ERROR');
        return;
      }

      // Measure and update ABR bandwidth
      const byteSize = segmentData.byteLength;
      const bps = downloadTimeMs > 0 ? (byteSize * 8 * 1000) / downloadTimeMs : 0;
      this.abrEngine!.updateBandwidth(bps);
      this.abrEngine!.recordMeasurement({
        segmentUrl,
        byteSize,
        downloadTimeMs,
        quality,
      });

      // Demux segment
      const demuxer = new TSDemuxer();
      const result = demuxer.demux(segmentData);

      // Generate SEPARATE media segments for video and audio
      const videoMediaSegment = generateMediaSegment(
        this.sequenceNumber, result.videoSamples, [], this.videoBaseDecodeTime, 0,
      );
      const audioMediaSegment = generateMediaSegment(
        this.sequenceNumber, [], result.audioSamples, 0, this.audioBaseDecodeTime,
      );

      await this.bufferManager.appendVideo(videoMediaSegment);
      await this.bufferManager.appendAudio(audioMediaSegment);

      // Increment segment index and baseDecodeTimes
      this.videoBaseDecodeTime += this.computeTotalDuration(result.videoSamples);
      this.audioBaseDecodeTime += this.computeTotalDuration(result.audioSamples);
      this.segmentIndex++;
      this.sequenceNumber++;

      // If REBUFFERING and buffer recovered, transition to PLAYING
      if (this.stateMachine.state === 'REBUFFERING') {
        const newBufferLevel = this.bufferManager.getBufferLevel(this.video.currentTime);
        if (newBufferLevel > REBUFFER_THRESHOLD) {
          this.stateMachine.transition('PLAYING');
        }
      }

      // Report bandwidth to server (fire-and-forget, non-critical)
      this.reportBandwidth(bps, quality).catch(() => { /* ignore */ });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute the total duration of a set of samples by summing PTS/DTS differences.
   */
  private computeTotalDuration(
    samples: Array<{ pts: number; dts?: number }>,
  ): number {
    if (samples.length === 0) return 0;
    if (samples.length === 1) {
      // Single sample: use a reasonable default (3000 for video at 90kHz, 1024 for audio)
      return 3000;
    }
    let total = 0;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1].dts ?? samples[i - 1].pts;
      const curr = samples[i].dts ?? samples[i].pts;
      total += curr - prev;
    }
    // Add duration of last sample (assume same as previous gap)
    const lastGap =
      (samples[samples.length - 1].dts ?? samples[samples.length - 1].pts) -
      (samples[samples.length - 2].dts ?? samples[samples.length - 2].pts);
    total += lastGap;
    return total;
  }

  private parseMasterPlaylist(text: string): QualityLevel[] {
    const levels: QualityLevel[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = line.substring('#EXT-X-STREAM-INF:'.length);
        const bwMatch = attrs.match(/BANDWIDTH=(\d+)/);
        const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
        if (bwMatch && resMatch) {
          const bandwidth = parseInt(bwMatch[1], 10);
          const width = parseInt(resMatch[1], 10);
          const height = parseInt(resMatch[2], 10);
          const name = `${height}p`;
          levels.push({
            name,
            width,
            height,
            videoBitrate: Math.floor(bandwidth * 0.9),
            audioBitrate: Math.floor(bandwidth * 0.1),
          });
        }
      }
    }
    return levels;
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    return response.text();
  }

  private async fetchBinary(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  private async reportBandwidth(bps: number, quality: QualityLevel): Promise<void> {
    try {
      await fetch('/api/bandwidth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bandwidth: bps, quality: quality.name }),
      });
    } catch {
      // Non-critical, ignore errors
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
