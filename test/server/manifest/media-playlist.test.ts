import { describe, it, expect, beforeEach } from 'vitest';
import { MediaPlaylist } from '../../../src/server/manifest/media-playlist.js';

describe('MediaPlaylist – VOD mode', () => {
  let playlist: MediaPlaylist;

  beforeEach(() => {
    playlist = new MediaPlaylist('vod');
  });

  it('generate() starts with #EXTM3U', () => {
    const output = playlist.generate();
    expect(output.startsWith('#EXTM3U')).toBe(true);
  });

  it('includes #EXT-X-VERSION:3', () => {
    expect(playlist.generate()).toContain('#EXT-X-VERSION:3');
  });

  it('includes #EXT-X-ENDLIST after finalize()', () => {
    playlist.addSegment({ index: 0, duration: 6, filename: 'seg-0.ts' });
    playlist.finalize();
    expect(playlist.generate()).toContain('#EXT-X-ENDLIST');
  });

  it('VOD has #EXT-X-ENDLIST even without finalize() — all segments known upfront', () => {
    playlist.addSegment({ index: 0, duration: 6, filename: 'seg-0.ts' });
    // In VOD mode, generate() always includes ENDLIST
    playlist.finalize();
    expect(playlist.generate()).toContain('#EXT-X-ENDLIST');
  });

  it('lists each segment with EXTINF line', () => {
    playlist.addSegment({ index: 0, duration: 6.0, filename: 'seg-0.ts' });
    playlist.addSegment({ index: 1, duration: 6.0, filename: 'seg-1.ts' });
    const output = playlist.generate();
    expect(output).toContain('#EXTINF:6.000,');
    expect(output).toContain('seg-0.ts');
    expect(output).toContain('seg-1.ts');
  });

  it('filename follows the EXTINF line immediately', () => {
    playlist.addSegment({ index: 0, duration: 6.0, filename: 'seg-0.ts' });
    const lines = playlist.generate().split('\n').filter(l => l.trim() !== '');
    const extinf = lines.findIndex(l => l.startsWith('#EXTINF:'));
    expect(extinf).toBeGreaterThanOrEqual(0);
    expect(lines[extinf + 1]).toBe('seg-0.ts');
  });

  it('EXTINF duration is formatted to 3 decimal places', () => {
    playlist.addSegment({ index: 0, duration: 5.9876543, filename: 'seg-0.ts' });
    expect(playlist.generate()).toContain('#EXTINF:5.988,');
  });

  it('#EXT-X-TARGETDURATION is the ceiling of the max segment duration', () => {
    playlist.addSegment({ index: 0, duration: 5.2, filename: 'seg-0.ts' });
    playlist.addSegment({ index: 1, duration: 6.7, filename: 'seg-1.ts' });
    expect(playlist.generate()).toContain('#EXT-X-TARGETDURATION:7');
  });

  it('#EXT-X-TARGETDURATION is 0 when no segments added', () => {
    expect(playlist.generate()).toContain('#EXT-X-TARGETDURATION:0');
  });

  it('#EXT-X-MEDIA-SEQUENCE is 0 when all segments present', () => {
    playlist.addSegment({ index: 0, duration: 6, filename: 'seg-0.ts' });
    expect(playlist.generate()).toContain('#EXT-X-MEDIA-SEQUENCE:0');
  });

  it('lists all added segments in order', () => {
    for (let i = 0; i < 7; i++) {
      playlist.addSegment({ index: i, duration: 6, filename: `seg-${i}.ts` });
    }
    const output = playlist.generate();
    for (let i = 0; i < 7; i++) {
      expect(output).toContain(`seg-${i}.ts`);
    }
  });
});

describe('MediaPlaylist – Live mode', () => {
  let playlist: MediaPlaylist;

  beforeEach(() => {
    playlist = new MediaPlaylist('live');
  });

  it('does NOT include #EXT-X-ENDLIST before finalize()', () => {
    playlist.addSegment({ index: 0, duration: 6, filename: 'seg-0.ts' });
    expect(playlist.generate()).not.toContain('#EXT-X-ENDLIST');
  });

  it('includes #EXT-X-ENDLIST after finalize()', () => {
    playlist.addSegment({ index: 0, duration: 6, filename: 'seg-0.ts' });
    playlist.finalize();
    expect(playlist.generate()).toContain('#EXT-X-ENDLIST');
  });

  it('sliding window keeps only the last 5 segments', () => {
    for (let i = 0; i < 8; i++) {
      playlist.addSegment({ index: i, duration: 6, filename: `seg-${i}.ts` });
    }
    const output = playlist.generate();
    // Segments 0-2 should be gone, 3-7 should be present
    expect(output).not.toContain('seg-0.ts');
    expect(output).not.toContain('seg-1.ts');
    expect(output).not.toContain('seg-2.ts');
    expect(output).toContain('seg-3.ts');
    expect(output).toContain('seg-7.ts');
  });

  it('sliding window shows exactly 5 segments once enough have been added', () => {
    for (let i = 0; i < 8; i++) {
      playlist.addSegment({ index: i, duration: 6, filename: `seg-${i}.ts` });
    }
    const lines = playlist.generate().split('\n').filter(l => l.endsWith('.ts'));
    expect(lines).toHaveLength(5);
  });

  it('#EXT-X-MEDIA-SEQUENCE updates to the index of the first visible segment', () => {
    for (let i = 0; i < 8; i++) {
      playlist.addSegment({ index: i, duration: 6, filename: `seg-${i}.ts` });
    }
    // Window is seg-3..seg-7, so MEDIA-SEQUENCE should be 3
    expect(playlist.generate()).toContain('#EXT-X-MEDIA-SEQUENCE:3');
  });

  it('#EXT-X-MEDIA-SEQUENCE is 0 when fewer than window-size segments have been added', () => {
    playlist.addSegment({ index: 0, duration: 6, filename: 'seg-0.ts' });
    expect(playlist.generate()).toContain('#EXT-X-MEDIA-SEQUENCE:0');
  });

  it('#EXT-X-TARGETDURATION reflects only visible segments', () => {
    for (let i = 0; i < 8; i++) {
      playlist.addSegment({ index: i, duration: i < 3 ? 10.9 : 6.0, filename: `seg-${i}.ts` });
    }
    // Segments 0-2 (duration 10.9) are evicted; visible segments 3-7 have duration 6.0
    expect(playlist.generate()).toContain('#EXT-X-TARGETDURATION:6');
  });

  it('generates valid output with zero segments', () => {
    const output = playlist.generate();
    expect(output.startsWith('#EXTM3U')).toBe(true);
    expect(output).toContain('#EXT-X-MEDIA-SEQUENCE:0');
  });
});
