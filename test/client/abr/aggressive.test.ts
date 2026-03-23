import { describe, it, expect } from 'vitest';
import { AggressiveStrategy } from '../../../src/client/abr/aggressive.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';
import { ABRContext } from '../../../src/client/abr/types.js';

function makeContext(bandwidth: number, bufferLevel: number): ABRContext {
  return {
    bandwidth,
    bufferLevel,
    history: [],
    qualityLevels: QUALITY_LEVELS,
    currentQuality: QUALITY_LEVELS[0],
  };
}

describe('AggressiveStrategy', () => {
  const strategy = new AggressiveStrategy();

  it('has name "aggressive"', () => {
    expect(strategy.name).toBe('aggressive');
  });

  it('selects 720p at 3Mbps with 15s buffer', () => {
    // 3_000_000 bandwidth, buffer >= 5
    // 360p: 864_000 <= 3_000_000 ✓
    // 480p: 1_496_000 <= 3_000_000 ✓
    // 720p: 2_928_000 <= 3_000_000 ✓
    // 1080p: 5_192_000 > 3_000_000 ✗
    const result = strategy.decide(makeContext(3_000_000, 15));
    expect(result.name).toBe('720p');
  });

  it('drops to 360p at 3Mbps with 2s buffer (buffer < 5)', () => {
    const result = strategy.decide(makeContext(3_000_000, 2));
    expect(result.name).toBe('360p');
  });

  it('selects 1080p at 20Mbps with 20s buffer', () => {
    // 20_000_000 bandwidth, buffer >= 5
    // 1080p: 5_192_000 <= 20_000_000 ✓
    const result = strategy.decide(makeContext(20_000_000, 20));
    expect(result.name).toBe('1080p');
  });

  it('drops to lowest when bufferLevel is exactly 0', () => {
    const result = strategy.decide(makeContext(20_000_000, 0));
    expect(result.name).toBe('360p');
  });

  it('drops to lowest when bufferLevel is exactly 4.9 (< 5)', () => {
    const result = strategy.decide(makeContext(20_000_000, 4.9));
    expect(result.name).toBe('360p');
  });

  it('does not drop when bufferLevel is exactly 5', () => {
    const result = strategy.decide(makeContext(20_000_000, 5));
    expect(result.name).toBe('1080p');
  });
});
