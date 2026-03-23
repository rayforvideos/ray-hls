import { EventEmitter } from 'events';
import { QualityLevel, QUALITY_LEVELS } from '../../shared/types.js';
import { getPresets, FFmpegPreset } from './quality-presets.js';
import { FFmpegProcess } from './ffmpeg-process.js';

export { getPresets } from './quality-presets.js';
export type { FFmpegPreset } from './quality-presets.js';
export { FFmpegProcess } from './ffmpeg-process.js';

export class Transcoder extends EventEmitter {
  private processes: Map<string, FFmpegProcess> = new Map();

  start(inputPath: string, levels?: QualityLevel[]): void {
    const targetLevels = levels ?? QUALITY_LEVELS;
    const presets = getPresets();

    for (const preset of presets) {
      // Only include this preset if its level is in the target list
      const include = targetLevels.some(l => l.name === preset.level.name);
      if (!include) continue;

      const proc = new FFmpegProcess(preset, inputPath);
      const levelName = preset.level.name;

      proc.on('videoData', (chunk: Buffer) => {
        this.emit('videoData', preset.level, chunk);
      });

      proc.on('audioData', (chunk: Buffer) => {
        this.emit('audioData', preset.level, chunk);
      });

      proc.on('videoEnd', (code: number | null) => {
        this.emit('videoEnd', preset.level, code);
      });

      proc.on('audioEnd', (code: number | null) => {
        this.emit('audioEnd', preset.level, code);
      });

      proc.on('error', (err: Error) => {
        this.emit('error', preset.level, err);
      });

      this.processes.set(levelName, proc);
      proc.start();
    }
  }

  stop(): void {
    for (const proc of this.processes.values()) {
      proc.stop();
    }
    this.processes.clear();
  }
}
