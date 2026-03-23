import { QualityLevel } from '../../shared/types.js';

const CODECS = 'avc1.42c01e,mp4a.40.2';

export function generateMasterPlaylist(levels: QualityLevel[]): string {
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '',
  ];

  for (const level of levels) {
    const bandwidth = level.videoBitrate + level.audioBitrate;
    const resolution = `${level.width}x${level.height}`;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},CODECS="${CODECS}"`,
      `${level.name}/playlist.m3u8`,
    );
  }

  return lines.join('\n');
}
