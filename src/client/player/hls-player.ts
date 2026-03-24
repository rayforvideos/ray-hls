import { PlayerStateMachine, PlayerState } from './state-machine.js';
import { BufferManager } from './buffer-manager.js';
import { TSDemuxer } from '../demuxer/ts-demuxer.js';
import { generateInitSegment } from '../remuxer/init-segment.js';
import { generateMediaSegment } from '../remuxer/media-segment.js';
import { ABREngine } from '../abr/abr-engine.js';
import { PrefetchEngine } from '../prefetch/prefetch-engine.js';
import { QualityLevel, QUALITY_LEVELS, NAL_TYPE_SPS, NAL_TYPE_PPS } from '../../shared/types.js';
import { parseNALUnits } from '../demuxer/nal-parser.js';
import { convertVideoSamples, convertAudioSamples } from '../remuxer/sample-converter.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const REBUFFER_THRESHOLD = 1; // seconds

function log(msg: string, ...args: unknown[]): void {
  console.log(`[Ray-HLS] ${msg}`, ...args);
}

function logError(msg: string, ...args: unknown[]): void {
  console.error(`[Ray-HLS] ${msg}`, ...args);
}

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
  private _lastBandwidth = 0;
  private _lastBufferLevel = 0;
  private _lastQuality = '-';
  private _totalSegments = Infinity;
  private _masterPlaylistUrl = '';

  constructor(video: HTMLVideoElement) {
    this.video = video;

    // Allow replay after ended: reload the entire stream
    this.video.addEventListener('play', () => {
      if (this.stateMachine.state === 'ENDED' && this._masterPlaylistUrl) {
        this.reset();
        this.load(this._masterPlaylistUrl);
      }
    });

    this.video.addEventListener('timeupdate', () => {
      const currentTime = this.video.currentTime;
      // Don't cleanup after stream has ended — removing buffered data causes stall
      if (this.stateMachine.state !== 'ENDED') {
        this.bufferManager.cleanup(currentTime);
      }

      const bufferLevel = this.bufferManager.getBufferLevel(currentTime);
      this._lastBufferLevel = bufferLevel;
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

  get lastBandwidth(): number { return this._lastBandwidth; }
  get lastBufferLevel(): number { return this._lastBufferLevel; }
  get lastQuality(): string { return this._lastQuality; }

  private reset(): void {
    // Revoke old MediaSource URL
    if (this.video.src) {
      URL.revokeObjectURL(this.video.src);
    }
    this.mediaSource = null;
    this.bufferManager = new BufferManager();
    this.segmentIndex = 0;
    this.videoBaseDecodeTime = 0;
    this.audioBaseDecodeTime = 0;
    this.sequenceNumber = 1;
    this._totalSegments = Infinity;
    this.stateMachine = new PlayerStateMachine();
    log('Player reset for replay');
  }

  async load(masterPlaylistUrl: string): Promise<void> {
    this._masterPlaylistUrl = masterPlaylistUrl;
    try {
      if (!this.stateMachine.transition('LOADING_MANIFEST')) {
        throw new Error('Cannot load: invalid state transition');
      }

      log('Fetching master playlist:', masterPlaylistUrl);
      const playlistText = await this.fetchText(masterPlaylistUrl);
      this.qualityLevels = this.parseMasterPlaylist(playlistText);
      if (this.qualityLevels.length === 0) {
        this.qualityLevels = [...QUALITY_LEVELS];
      }
      log('Quality levels:', this.qualityLevels.map(q => q.name));
      this.abrEngine = new ABREngine(this.qualityLevels);

      const lastSlash = masterPlaylistUrl.lastIndexOf('/');
      this.baseUrl = lastSlash >= 0 ? masterPlaylistUrl.substring(0, lastSlash) : '';

      // Fetch media playlist to get total duration and segment count
      const firstQuality = this.qualityLevels[0];
      const mediaPlaylistUrl = `${this.baseUrl}/${firstQuality.name}/playlist.m3u8`;
      const mediaPlaylistText = await this.fetchText(mediaPlaylistUrl);
      const { totalDuration, segmentCount } = this.parseMediaPlaylist(mediaPlaylistText);
      this._totalSegments = segmentCount;
      log('Media playlist: duration=' + totalDuration.toFixed(1) + 's, segments=' + segmentCount);

      // Fetch first segment BEFORE creating MediaSource (need SPS for codec string)
      const quality = this.abrEngine.decide();
      this._lastQuality = quality.name;
      const firstSegmentUrl = `${this.baseUrl}/${quality.name}/${quality.name}-seg-${this.segmentIndex}.ts`;
      log('Fetching first segment:', firstSegmentUrl);
      const firstSegmentData = await this.fetchBinary(firstSegmentUrl);
      log('First segment size:', firstSegmentData.byteLength);

      const demuxer = new TSDemuxer();
      const result = demuxer.demux(firstSegmentData);
      log('Demuxed:', result.videoSamples.length, 'video samples,', result.audioSamples.length, 'audio samples');

      // Extract SPS and PPS
      let sps: Uint8Array | null = null;
      let pps: Uint8Array | null = null;
      for (const sample of result.videoSamples) {
        const nalUnits = parseNALUnits(sample.data);
        for (const nal of nalUnits) {
          if (nal.type === NAL_TYPE_SPS && !sps) sps = nal.data;
          if (nal.type === NAL_TYPE_PPS && !pps) pps = nal.data;
        }
        if (sps && pps) break;
      }

      if (!sps || !pps) {
        logError('Could not find SPS/PPS in first segment');
        this.stateMachine.transition('ERROR');
        throw new Error('Could not find SPS/PPS in first segment');
      }

      // Build codec string from actual SPS
      const profile = sps[1];
      const compat = sps[2];
      const level = sps[3];
      const codecStr = `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
      log('Detected video codec:', codecStr);
      log('SPS length:', sps.length, 'PPS length:', pps.length);

      // Now create MediaSource with the correct codec
      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);

      this.stateMachine.transition('LOADING_INIT_SEGMENT');

      await new Promise<void>((resolve) => {
        this.mediaSource!.addEventListener('sourceopen', () => resolve(), { once: true });
      });

      log('MediaSource opened, adding SourceBuffers...');

      // Set duration from playlist so the timeline bar shows total length immediately
      if (totalDuration > 0) {
        this.mediaSource.duration = totalDuration;
        log('Set duration from playlist:', totalDuration);
      }

      const videoSourceBuffer = this.mediaSource.addSourceBuffer(
        `video/mp4; codecs="${codecStr}"`,
      );
      const audioSourceBuffer = this.mediaSource.addSourceBuffer(
        'audio/mp4; codecs="mp4a.40.2"',
      );

      this.bufferManager.attach(videoSourceBuffer, audioSourceBuffer);

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

      log('Appending video init segment:', videoInitSegment.byteLength, 'bytes');
      await this.bufferManager.appendVideo(videoInitSegment);
      log('Appending audio init segment:', audioInitSegment.byteLength, 'bytes');
      await this.bufferManager.appendAudio(audioInitSegment);

      // Convert samples: Annex B → AVCC for video, strip ADTS for audio
      const videoSamples = convertVideoSamples(result.videoSamples);
      const audioSamples = convertAudioSamples(result.audioSamples);
      log('Converted samples: video', videoSamples.length, 'audio', audioSamples.length);

      // Generate and append first media segment
      log('Generating media segments for segment 0...');
      const videoMediaSegment = generateMediaSegment(
        this.sequenceNumber, videoSamples, [], this.videoBaseDecodeTime, 0,
      );
      const audioMediaSegment = generateMediaSegment(
        this.sequenceNumber, [], audioSamples, 0, this.audioBaseDecodeTime,
      );

      log('Appending video media segment:', videoMediaSegment.byteLength, 'bytes');
      await this.bufferManager.appendVideo(videoMediaSegment);
      log('Appending audio media segment:', audioMediaSegment.byteLength, 'bytes');
      await this.bufferManager.appendAudio(audioMediaSegment);

      this.videoBaseDecodeTime += this.computeTotalDuration(videoSamples);
      // Keep audio in sync with video to avoid duration mismatch
      this.audioBaseDecodeTime = this.videoBaseDecodeTime;
      log('videoBaseDecodeTime:', this.videoBaseDecodeTime, 'audioBaseDecodeTime:', this.audioBaseDecodeTime);
      this.segmentIndex++;
      this.sequenceNumber++;

      this.stateMachine.transition('BUFFERING');
      this.stateMachine.transition('PLAYING');
      log('Playing!');
      this.video.play().catch((e) => { log('Autoplay blocked:', e.message); });

      this.loadLoop();
    } catch (err) {
      logError('Load failed:', err);
      this.stateMachine.transition('ERROR');
    }
  }

  private async loadLoop(): Promise<void> {
    while (
      this.stateMachine.state === 'PLAYING' ||
      this.stateMachine.state === 'REBUFFERING'
    ) {
      const bufferLevel = this.bufferManager.getBufferLevel(this.video.currentTime);
      const currentQuality = this.abrEngine!.decide();
      this._lastQuality = currentQuality.name;
      const prefetchDecision = this.prefetchEngine.shouldPrefetch({
        bufferLevel,
        bandwidth: this._lastBandwidth,
        currentQuality,
        nextSegmentIndex: this.segmentIndex,
      });

      if (!prefetchDecision.shouldFetch) {
        await this.sleep(1000);
        // If playback reached near the end of buffered data, probe for next segment
        // to trigger 404 → endOfStream
        const buffered = this.bufferManager.getBufferLevel(this.video.currentTime);
        if (buffered < 2 && this.segmentIndex > 0) {
          // Let it fall through to fetch — if 404, stream ends cleanly
        } else {
          continue;
        }
      }

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
            log('Segment not found (end of stream):', segmentUrl);
            this.stateMachine.transition('ENDED');
            // Wait for any pending SourceBuffer updates before endOfStream
            await this.bufferManager.waitForIdle();
            if (this.mediaSource && this.mediaSource.readyState === 'open') {
              try {
                this.mediaSource.endOfStream();
                log('endOfStream called, duration:', this.video.duration);
              } catch (e) {
                log('endOfStream error (non-fatal):', e);
              }
            }
            return;
          }

          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const buffer = await response.arrayBuffer();
          downloadTimeMs = performance.now() - startTime;
          segmentData = new Uint8Array(buffer);
          break;
        } catch (err) {
          retryCount++;
          if (retryCount >= MAX_RETRIES) {
            logError('Max retries reached for:', segmentUrl);
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

      const byteSize = segmentData.byteLength;
      const bps = downloadTimeMs > 0 ? (byteSize * 8 * 1000) / downloadTimeMs : 0;
      this._lastBandwidth = bps;
      this.abrEngine!.updateBandwidth(bps);
      this.abrEngine!.recordMeasurement({ segmentUrl, byteSize, downloadTimeMs, quality });

      try {
        const demuxer = new TSDemuxer();
        const result = demuxer.demux(segmentData);
        const videoSamples = convertVideoSamples(result.videoSamples);
        const audioSamples = convertAudioSamples(result.audioSamples);
        log(`Segment ${this.segmentIndex}: ${videoSamples.length}v + ${audioSamples.length}a samples`);

        const videoMediaSegment = generateMediaSegment(
          this.sequenceNumber, videoSamples, [], this.videoBaseDecodeTime, 0,
        );
        const audioMediaSegment = generateMediaSegment(
          this.sequenceNumber, [], audioSamples, 0, this.audioBaseDecodeTime,
        );

        await this.bufferManager.appendVideo(videoMediaSegment);
        await this.bufferManager.appendAudio(audioMediaSegment);

        this.videoBaseDecodeTime += this.computeTotalDuration(videoSamples);
        this.audioBaseDecodeTime += this.computeTotalDuration(audioSamples);
        this.segmentIndex++;
        this.sequenceNumber++;

        if (this.stateMachine.state === 'REBUFFERING') {
          const newBufferLevel = this.bufferManager.getBufferLevel(this.video.currentTime);
          if (newBufferLevel > REBUFFER_THRESHOLD) {
            this.stateMachine.transition('PLAYING');
          }
        }

        this.reportBandwidth(bps, quality).catch(() => {});

        // If we've loaded all segments, end the stream
        if (this.segmentIndex >= this._totalSegments) {
          log('All segments loaded, ending stream');
          this.stateMachine.transition('ENDED');
          await this.bufferManager.waitForIdle();
          if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try {
              this.mediaSource.endOfStream();
              log('endOfStream called, duration:', this.video.duration);
            } catch (e) {
              log('endOfStream error (non-fatal):', e);
            }
          }
          return;
        }
      } catch (err) {
        logError('Segment processing error:', err);
      }
    }
  }

  private computeTotalDuration(samples: Array<{ pts: number; dts?: number }>): number {
    if (samples.length === 0) return 0;
    if (samples.length === 1) return 3000;
    let total = 0;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1].dts ?? samples[i - 1].pts;
      const curr = samples[i].dts ?? samples[i].pts;
      total += curr - prev;
    }
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

  private parseMediaPlaylist(text: string): { totalDuration: number; segmentCount: number } {
    let totalDuration = 0;
    let segmentCount = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#EXTINF:')) {
        const dur = parseFloat(trimmed.substring(8));
        if (!isNaN(dur)) totalDuration += dur;
      } else if (trimmed.length > 0 && !trimmed.startsWith('#')) {
        segmentCount++;
      }
    }
    return { totalDuration, segmentCount };
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    return response.text();
  }

  private async fetchBinary(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async reportBandwidth(bps: number, quality: QualityLevel): Promise<void> {
    try {
      await fetch('/api/bandwidth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: 'player-1',
          measuredBandwidth: bps,
          currentQuality: quality.name,
          bufferLevel: this._lastBufferLevel,
        }),
      });
    } catch { /* ignore */ }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
