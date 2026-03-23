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
    // Build base input args
    const inputArgs = ['-i', this.inputPath];

    // --- Video process: no audio (-an), output to stdout (pipe:1) ---
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

    // --- Audio process: no video (-vn), output to stdout (pipe:1) ---
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
