import { QualityLevel, QUALITY_LEVELS } from '../../shared/types.js';

export interface FFmpegPreset {
  level: QualityLevel;
  videoArgs: string[];
  audioArgs: string[];
}

export function getPresets(keyframeInterval: number = 180): FFmpegPreset[] {
  return QUALITY_LEVELS.map((level): FFmpegPreset => {
    const videoArgs = [
      '-c:v', 'libx264',
      '-b:v', String(level.videoBitrate),
      '-s', `${level.width}x${level.height}`,
      '-g', String(keyframeInterval),
      '-keyint_min', String(keyframeInterval),
      '-sc_threshold', '0',
      '-profile:v', 'main',
      '-preset', 'fast',
      '-f', 'h264',
    ];

    const audioArgs = [
      '-c:a', 'aac',
      '-b:a', String(level.audioBitrate),
      '-ar', '44100',
      '-ac', '2',
      '-f', 'adts',
    ];

    return { level, videoArgs, audioArgs };
  });
}
