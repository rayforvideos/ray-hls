import { describe, it, expect } from 'vitest';
import { getPresets } from '../../../src/server/transcoder/quality-presets.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';

describe('getPresets()', () => {
  it('generates presets for all 4 quality levels', () => {
    const presets = getPresets();
    expect(presets).toHaveLength(4);
    const names = presets.map(p => p.level.name);
    expect(names).toEqual(['360p', '480p', '720p', '1080p']);
  });

  it('each preset level matches the corresponding QUALITY_LEVELS entry', () => {
    const presets = getPresets();
    for (let i = 0; i < QUALITY_LEVELS.length; i++) {
      expect(presets[i].level).toEqual(QUALITY_LEVELS[i]);
    }
  });

  it('includes correct resolution in video args (e.g. 640x360 for 360p)', () => {
    const presets = getPresets();
    const p360 = presets.find(p => p.level.name === '360p')!;
    expect(p360.videoArgs).toContain('640x360');

    const p480 = presets.find(p => p.level.name === '480p')!;
    expect(p480.videoArgs).toContain('854x480');

    const p720 = presets.find(p => p.level.name === '720p')!;
    expect(p720.videoArgs).toContain('1280x720');

    const p1080 = presets.find(p => p.level.name === '1080p')!;
    expect(p1080.videoArgs).toContain('1920x1080');
  });

  it('includes correct video bitrate as a plain number string', () => {
    const presets = getPresets();
    const p360 = presets.find(p => p.level.name === '360p')!;
    expect(p360.videoArgs).toContain('800000');

    const p1080 = presets.find(p => p.level.name === '1080p')!;
    expect(p1080.videoArgs).toContain('5000000');
  });

  it('includes correct audio bitrate as a plain number string', () => {
    const presets = getPresets();
    const p360 = presets.find(p => p.level.name === '360p')!;
    expect(p360.audioArgs).toContain('64000');

    const p1080 = presets.find(p => p.level.name === '1080p')!;
    expect(p1080.audioArgs).toContain('192000');
  });

  it('sets default keyframe interval of 180 in video args', () => {
    const presets = getPresets();
    for (const preset of presets) {
      const gIdx = preset.videoArgs.indexOf('-g');
      expect(gIdx).toBeGreaterThanOrEqual(0);
      expect(preset.videoArgs[gIdx + 1]).toBe('180');

      const keyintIdx = preset.videoArgs.indexOf('-keyint_min');
      expect(keyintIdx).toBeGreaterThanOrEqual(0);
      expect(preset.videoArgs[keyintIdx + 1]).toBe('180');
    }
  });

  it('respects a custom keyframe interval', () => {
    const presets = getPresets(90);
    for (const preset of presets) {
      const gIdx = preset.videoArgs.indexOf('-g');
      expect(preset.videoArgs[gIdx + 1]).toBe('90');

      const keyintIdx = preset.videoArgs.indexOf('-keyint_min');
      expect(preset.videoArgs[keyintIdx + 1]).toBe('90');
    }
  });

  it('outputs Annex B format (-f h264) in videoArgs', () => {
    const presets = getPresets();
    for (const preset of presets) {
      const fIdx = preset.videoArgs.indexOf('-f');
      expect(fIdx).toBeGreaterThanOrEqual(0);
      expect(preset.videoArgs[fIdx + 1]).toBe('h264');
    }
  });

  it('outputs ADTS format (-f adts) in audioArgs', () => {
    const presets = getPresets();
    for (const preset of presets) {
      const fIdx = preset.audioArgs.indexOf('-f');
      expect(fIdx).toBeGreaterThanOrEqual(0);
      expect(preset.audioArgs[fIdx + 1]).toBe('adts');
    }
  });

  it('sets sc_threshold to 0 to disable scene-cut detection', () => {
    const presets = getPresets();
    for (const preset of presets) {
      const idx = preset.videoArgs.indexOf('-sc_threshold');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(preset.videoArgs[idx + 1]).toBe('0');
    }
  });

  it('uses libx264 video codec in all presets', () => {
    const presets = getPresets();
    for (const preset of presets) {
      expect(preset.videoArgs).toContain('libx264');
    }
  });

  it('uses aac audio codec in all presets', () => {
    const presets = getPresets();
    for (const preset of presets) {
      expect(preset.audioArgs).toContain('aac');
    }
  });

  it('sets 44100 Hz sample rate and 2 channels in all audio presets', () => {
    const presets = getPresets();
    for (const preset of presets) {
      expect(preset.audioArgs).toContain('44100');
      const acIdx = preset.audioArgs.indexOf('-ac');
      expect(acIdx).toBeGreaterThanOrEqual(0);
      expect(preset.audioArgs[acIdx + 1]).toBe('2');
    }
  });
});
