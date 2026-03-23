import { describe, it, expect } from 'vitest';
import { ConservativeStrategy } from '../../../src/client/abr/conservative.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';
import { ABRContext } from '../../../src/client/abr/types.js';

function makeContext(bandwidth: number): ABRContext {
  return {
    bandwidth,
    bufferLevel: 10,
    history: [],
    qualityLevels: QUALITY_LEVELS,
    currentQuality: QUALITY_LEVELS[0],
  };
}

describe('ConservativeStrategy', () => {
  const strategy = new ConservativeStrategy();

  it('has name "conservative"', () => {
    expect(strategy.name).toBe('conservative');
  });

  it('selects 480p at 3Mbps (usable = 2.1Mbps, 480p total = 1.496Mbps)', () => {
    // 3_000_000 * 0.7 = 2_100_000
    // 360p: 864_000 <= 2_100_000 ✓
    // 480p: 1_496_000 <= 2_100_000 ✓
    // 720p: 2_928_000 > 2_100_000 ✗
    const result = strategy.decide(makeContext(3_000_000));
    expect(result.name).toBe('480p');
  });

  it('selects 360p at 500kbps (usable = 350kbps, only lowest fits or falls back to lowest)', () => {
    // 500_000 * 0.7 = 350_000
    // 360p: 864_000 > 350_000 - none fit, returns lowest
    const result = strategy.decide(makeContext(500_000));
    expect(result.name).toBe('360p');
  });

  it('selects 1080p at 20Mbps (usable = 14Mbps, all levels fit)', () => {
    // 20_000_000 * 0.7 = 14_000_000
    // 1080p: 5_192_000 <= 14_000_000 ✓
    const result = strategy.decide(makeContext(20_000_000));
    expect(result.name).toBe('1080p');
  });

  it('always returns at least the lowest quality level', () => {
    const result = strategy.decide(makeContext(0));
    expect(result.name).toBe('360p');
  });
});
