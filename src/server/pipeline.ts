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

  // 화질별 PTS 추적
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

    // 화질별로 TSPackager 인스턴스 생성
    for (const level of this.levels) {
      const packager = new TSPackager(level);
      this.packagers.set(level.name, packager);
      this.videoFrameCount.set(level.name, 0);
      this.audioFrameCount.set(level.name, 0);

      // 패키저에서 세그먼트 이벤트를 수신
      packager.on('segment', (info, data: Buffer) => {
        // 세그먼트를 디스크에 저장
        const qualityDir = path.join(this.options.outputDir, level.name);
        fs.mkdirSync(qualityDir, { recursive: true });
        const segPath = path.join(qualityDir, info.filename);
        fs.writeFileSync(segPath, data);

        // 매니페스트 갱신
        this.manifest.addSegment(level.name, {
          index: info.index,
          duration: info.duration,
          filename: info.filename,
        });

        // HLS 서버 갱신 — 세그먼트 데이터 추가 및 미디어 플레이리스트 갱신
        this.server.addSegment(level.name, info.filename, data);
        const mediaPlaylist = this.manifest.getMediaPlaylist(level.name);
        if (mediaPlaylist !== null) {
          this.server.setMediaPlaylist(level.name, mediaPlaylist);
        }

        this.emit('segment', info);
      });
    }

    // 트랜스코더의 비디오 데이터를 패키저로 전달
    this.transcoder.on('videoData', (level: QualityLevel, chunk: Buffer) => {
      const packager = this.packagers.get(level.name);
      if (!packager) return;

      // PTS 계산: 30fps 기준 프레임당 3000틱 (90000 / 30)
      const frameCount = this.videoFrameCount.get(level.name) ?? 0;
      const pts = frameCount * 3000;
      this.videoFrameCount.set(level.name, frameCount + 1);

      packager.pushVideo(chunk, pts);
    });

    // 트랜스코더의 오디오 데이터를 패키저로 전달
    this.transcoder.on('audioData', (level: QualityLevel, chunk: Buffer) => {
      const packager = this.packagers.get(level.name);
      if (!packager) return;

      // PTS 계산: AAC 프레임당 1024 샘플 (44100Hz 기준)
      const frameCount = this.audioFrameCount.get(level.name) ?? 0;
      const pts = Math.round(frameCount * (PTS_CLOCK_RATE * 1024 / 44100));
      this.audioFrameCount.set(level.name, frameCount + 1);

      packager.pushAudio(chunk, pts);
    });

    // 트랜스코더 에러 처리
    this.transcoder.on('error', (level: QualityLevel, err: Error) => {
      this.emit('error', err);
    });
  }

  async start(): Promise<void> {
    // 입력 파일 검증
    const ingest = new FileIngest(this.options.inputPath);
    const inputPath = ingest.getInputPath();

    // 출력 디렉토리 생성
    fs.mkdirSync(this.options.outputDir, { recursive: true });

    // 서버에 마스터 플레이리스트 설정
    this.server.setMasterPlaylist(this.manifest.getMasterPlaylist());

    // HTTP 서버 시작
    await this.server.start();
    this.emit('ready', this.options.port);

    // 트랜스코더 시작
    this.transcoder.start(inputPath, this.levels);
  }

  async stop(): Promise<void> {
    // 트랜스코더 중지
    this.transcoder.stop();

    // 모든 패키저 플러시
    for (const packager of this.packagers.values()) {
      packager.flush();
    }

    // VOD 모드일 때 매니페스트 확정
    if (this.options.mode === 'vod') {
      this.manifest.finalize();
      // 확정된 플레이리스트를 서버에 갱신
      for (const level of this.levels) {
        const mediaPlaylist = this.manifest.getMediaPlaylist(level.name);
        if (mediaPlaylist !== null) {
          this.server.setMediaPlaylist(level.name, mediaPlaylist);
        }
      }
    }

    // HTTP 서버 중지
    await this.server.stop();
  }
}
