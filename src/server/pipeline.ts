import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { QualityLevel, QUALITY_LEVELS, PTS_CLOCK_RATE } from '../shared/types.js';
import { FileIngest } from './ingest/file-ingest.js';
import { Transcoder } from './transcoder/index.js';
import { TSPackager } from './packager/index.js';
import { ManifestGenerator } from './manifest/index.js';
import { HLSServer } from './http/server.js';

export interface PipelineOptions {
  inputPath: string;
  outputDir: string;
  port: number;
  mode: 'vod' | 'live';
  levels?: QualityLevel[];
}

export class Pipeline extends EventEmitter {
  private options: PipelineOptions;
  private levels: QualityLevel[];
  private transcoder: Transcoder;
  private packagers: Map<string, TSPackager>;
  private manifest: ManifestGenerator;
  private server: HLSServer;

  // PTS tracking per quality level
  private videoFrameCount: Map<string, number> = new Map();
  private audioFrameCount: Map<string, number> = new Map();

  constructor(options: PipelineOptions) {
    super();
    this.options = options;
    this.levels = options.levels ?? QUALITY_LEVELS;

    this.transcoder = new Transcoder();
    this.packagers = new Map();
    this.manifest = new ManifestGenerator(this.levels, options.mode);
    this.server = new HLSServer(options.port);

    // Create one TSPackager per quality level
    for (const level of this.levels) {
      const packager = new TSPackager(level);
      this.packagers.set(level.name, packager);
      this.videoFrameCount.set(level.name, 0);
      this.audioFrameCount.set(level.name, 0);

      // Wire segment events from packager
      packager.on('segment', (info, data: Buffer) => {
        // Write segment to disk
        const qualityDir = path.join(this.options.outputDir, level.name);
        fs.mkdirSync(qualityDir, { recursive: true });
        const segPath = path.join(qualityDir, info.filename);
        fs.writeFileSync(segPath, data);

        // Update manifest
        this.manifest.addSegment(level.name, {
          index: info.index,
          duration: info.duration,
          filename: info.filename,
        });

        // Update HLS server — add segment data and refresh media playlist
        this.server.addSegment(level.name, info.filename, data);
        const mediaPlaylist = this.manifest.getMediaPlaylist(level.name);
        if (mediaPlaylist !== null) {
          this.server.setMediaPlaylist(level.name, mediaPlaylist);
        }

        this.emit('segment', info);
      });
    }

    // Wire transcoder video data to packagers
    this.transcoder.on('videoData', (level: QualityLevel, chunk: Buffer) => {
      const packager = this.packagers.get(level.name);
      if (!packager) return;

      // Compute PTS: 3000 ticks per frame at 30fps (90000 / 30)
      const frameCount = this.videoFrameCount.get(level.name) ?? 0;
      const pts = frameCount * 3000;
      this.videoFrameCount.set(level.name, frameCount + 1);

      packager.pushVideo(chunk, pts);
    });

    // Wire transcoder audio data to packagers
    this.transcoder.on('audioData', (level: QualityLevel, chunk: Buffer) => {
      const packager = this.packagers.get(level.name);
      if (!packager) return;

      // Compute PTS: each AAC frame = 1024 samples at 44100Hz
      const frameCount = this.audioFrameCount.get(level.name) ?? 0;
      const pts = Math.round(frameCount * (PTS_CLOCK_RATE * 1024 / 44100));
      this.audioFrameCount.set(level.name, frameCount + 1);

      packager.pushAudio(chunk, pts);
    });

    // Handle transcoder errors
    this.transcoder.on('error', (level: QualityLevel, err: Error) => {
      this.emit('error', err);
    });
  }

  async start(): Promise<void> {
    // Validate input file
    const ingest = new FileIngest(this.options.inputPath);
    const inputPath = ingest.getInputPath();

    // Ensure output dir exists
    fs.mkdirSync(this.options.outputDir, { recursive: true });

    // Set master playlist on server
    this.server.setMasterPlaylist(this.manifest.getMasterPlaylist());

    // Start HTTP server
    await this.server.start();
    this.emit('ready', this.options.port);

    // Start transcoder
    this.transcoder.start(inputPath, this.levels);
  }

  async stop(): Promise<void> {
    // Stop transcoder
    this.transcoder.stop();

    // Flush all packagers
    for (const packager of this.packagers.values()) {
      packager.flush();
    }

    // Finalize manifests for VOD
    if (this.options.mode === 'vod') {
      this.manifest.finalize();
      // Update finalized playlists on server
      for (const level of this.levels) {
        const mediaPlaylist = this.manifest.getMediaPlaylist(level.name);
        if (mediaPlaylist !== null) {
          this.server.setMediaPlaylist(level.name, mediaPlaylist);
        }
      }
    }

    // Stop HTTP server
    await this.server.stop();
  }
}
