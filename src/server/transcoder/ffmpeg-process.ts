import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { FFmpegPreset } from './quality-presets.js';

export class FFmpegProcess extends EventEmitter {
  private preset: FFmpegPreset;
  private inputPath: string;
  private videoProc: ChildProcess | null = null;
  private audioProc: ChildProcess | null = null;

  constructor(preset: FFmpegPreset, inputPath: string) {
    super();
    this.preset = preset;
    this.inputPath = inputPath;
  }

  start(): void {
    // 기본 입력 인자 구성
    const inputArgs = ['-i', this.inputPath];

    // --- 비디오 프로세스: 오디오 제외(-an), 표준 출력으로 전달(pipe:1) ---
    const videoArgs = [
      ...inputArgs,
      '-an',
      ...this.preset.videoArgs,
      'pipe:1',
    ];

    this.videoProc = spawn('ffmpeg', videoArgs);

    this.videoProc.stdout?.on('data', (chunk: Buffer) => {
      this.emit('videoData', chunk);
    });

    this.videoProc.on('close', (code: number | null) => {
      this.emit('videoEnd', code);
    });

    this.videoProc.on('error', (err: Error) => {
      this.emit('error', err);
    });

    // --- 오디오 프로세스: 비디오 제외(-vn), 표준 출력으로 전달(pipe:1) ---
    const audioArgs = [
      ...inputArgs,
      '-vn',
      ...this.preset.audioArgs,
      'pipe:1',
    ];

    this.audioProc = spawn('ffmpeg', audioArgs);

    this.audioProc.stdout?.on('data', (chunk: Buffer) => {
      this.emit('audioData', chunk);
    });

    this.audioProc.on('close', (code: number | null) => {
      this.emit('audioEnd', code);
    });

    this.audioProc.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  stop(): void {
    this.videoProc?.kill('SIGTERM');
    this.audioProc?.kill('SIGTERM');
    this.videoProc = null;
    this.audioProc = null;
  }
}
