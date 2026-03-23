import { describe, it, expect } from 'vitest';
import { generateMasterPlaylist } from '../../../src/server/manifest/master-playlist.js';
import { QualityLevel } from '../../../src/shared/types.js';

const LEVELS: QualityLevel[] = [
  { name: '360p',  width: 640,  height: 360,  videoBitrate: 800_000,  audioBitrate: 64_000  },
  { name: '480p',  width: 854,  height: 480,  videoBitrate: 1_400_000, audioBitrate: 96_000  },
  { name: '720p',  width: 1280, height: 720,  videoBitrate: 2_800_000, audioBitrate: 128_000 },
  { name: '1080p', width: 1920, height: 1080, videoBitrate: 5_000_000, audioBitrate: 192_000 },
];

describe('generateMasterPlaylist', () => {
  it('starts with #EXTM3U', () => {
    const output = generateMasterPlaylist(LEVELS);
    expect(output.startsWith('#EXTM3U')).toBe(true);
  });

  it('includes #EXT-X-VERSION:3', () => {
    const output = generateMasterPlaylist(LEVELS);
    expect(output).toContain('#EXT-X-VERSION:3');
  });

  it('has an EXT-X-STREAM-INF line for each quality level', () => {
    const output = generateMasterPlaylist(LEVELS);
    const streamInfLines = output.split('\n').filter(l => l.startsWith('#EXT-X-STREAM-INF:'));
    expect(streamInfLines).toHaveLength(LEVELS.length);
  });

  it('includes BANDWIDTH attribute equal to videoBitrate + audioBitrate for each level', () => {
    const output = generateMasterPlaylist(LEVELS);
    for (const level of LEVELS) {
      const bandwidth = level.videoBitrate + level.audioBitrate;
      expect(output).toContain(`BANDWIDTH=${bandwidth}`);
    }
  });

  it('includes RESOLUTION attribute for each level', () => {
    const output = generateMasterPlaylist(LEVELS);
    for (const level of LEVELS) {
      expect(output).toContain(`RESOLUTION=${level.width}x${level.height}`);
    }
  });

  it('includes CODECS attribute "avc1.42c01e,mp4a.40.2" for all levels', () => {
    const output = generateMasterPlaylist(LEVELS);
    const streamInfLines = output.split('\n').filter(l => l.startsWith('#EXT-X-STREAM-INF:'));
    for (const line of streamInfLines) {
      expect(line).toContain('CODECS="avc1.42c01e,mp4a.40.2"');
    }
  });

  it('includes variant playlist URL for each quality level', () => {
    const output = generateMasterPlaylist(LEVELS);
    for (const level of LEVELS) {
      expect(output).toContain(`${level.name}/playlist.m3u8`);
    }
  });

  it('variant URL immediately follows its EXT-X-STREAM-INF line', () => {
    const output = generateMasterPlaylist(LEVELS);
    const lines = output.split('\n').filter(l => l.trim() !== '');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        expect(lines[i + 1]).toMatch(/^[^#]/);
      }
    }
  });

  it('works with a single quality level', () => {
    const single = [LEVELS[0]];
    const output = generateMasterPlaylist(single);
    expect(output.startsWith('#EXTM3U')).toBe(true);
    expect(output).toContain('#EXT-X-STREAM-INF:');
    expect(output).toContain('360p/playlist.m3u8');
  });

  it('360p entry has correct BANDWIDTH of 864000', () => {
    const output = generateMasterPlaylist([LEVELS[0]]);
    expect(output).toContain('BANDWIDTH=864000');
  });
});
