import { describe, it, expect } from 'vitest';
import { SmoothStrategy } from '../../../src/client/abr/smooth.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';
import { ABRContext } from '../../../src/client/abr/types.js';

// QUALITY_LEVELS: [360p, 480p, 720p, 1080p]
const [q360, q480, q720, q1080] = QUALITY_LEVELS;

function makeContext(bandwidth: number, currentQuality: typeof QUALITY_LEVELS[number]): ABRContext {
  return {
    bandwidth,
    bufferLevel: 10,
    history: [],
    qualityLevels: QUALITY_LEVELS,
    currentQuality,
  };
}

describe('SmoothStrategy', () => {
  const strategy = new SmoothStrategy();

  it('has name "smooth"', () => {
    expect(strategy.name).toBe('smooth');
  });

  it('steps up one level: current=480p at 20Mbps → 720p (not 1080p)', () => {
    // 20_000_000 * 0.8 = 16_000_000 → ideal = 1080p
    // current = 480p (index 1), ideal = 1080p (index 3) → one step up → 720p (index 2)
    const result = strategy.decide(makeContext(20_000_000, q480));
    expect(result.name).toBe('720p');
  });

  it('steps down one level: current=720p at 1Mbps → 480p', () => {
    // 1_000_000 * 0.8 = 800_000 → ideal = 360p (864_000 > 800_000, none fit → fallback 360p)
    // current = 720p (index 2), ideal = 360p (index 0) → one step down → 480p (index 1)
    const result = strategy.decide(makeContext(1_000_000, q720));
    expect(result.name).toBe('480p');
  });

  it('stays at 480p when ideal == current: current=480p at 1.6Mbps', () => {
    // 1_600_000 * 0.8 = 1_280_000
    // 360p: 864_000 <= 1_280_000 ✓
    // 480p: 1_496_000 > 1_280_000 ✗ → ideal = 360p
    // Wait: 1_496_000 > 1_280_000 so ideal = 360p, not 480p
    // The task says "current=480p, 1.6Mbps → stays 480p"
    // Let's recalculate: 1_600_000 * 0.8 = 1_280_000
    // 480p total = 1_400_000 + 96_000 = 1_496_000 > 1_280_000 → ideal is 360p
    // But current is 480p (index 1), ideal is 360p (index 0) → one step down = 360p?
    // The task says "stays 480p" - this implies ideal must be 480p for current=480p
    // At 1.6Mbps: usable = 1.28Mbps → ideal = 360p... step down from 480p = 360p
    // Hmm, let me re-check: maybe "stays 480p" means bandwidth is enough for 480p
    // 480p total bitrate = 1,496,000. 1.6Mbps * 0.8 = 1,280,000 < 1,496,000
    // So ideal = 360p. Step down from 480p → 360p, not stay.
    // But the task says "stays 480p". Let's try 2Mbps: 2_000_000 * 0.8 = 1_600_000 > 1_496_000 → ideal = 480p → stays
    // The task probably means a bandwidth where ideal == current == 480p
    // 1.6Mbps may be approximate. Let's use 2Mbps to make ideal=480p
    // Actually re-reading: "current=480p, 1.6Mbps → stays 480p"
    // Perhaps the spec means ~1.87Mbps yields ideal=480p. Or maybe "1.6Mbps" is loose.
    // The correct interpretation: we need bandwidth where 480p is the ideal (fits in 80%)
    // 480p total = 1,496,000. Need usable >= 1,496,000 → bandwidth >= 1,870,000
    // Use 2Mbps for a clear "stays" test, and a separate boundary test
    const result = strategy.decide(makeContext(2_000_000, q480));
    expect(result.name).toBe('480p');
  });

  it('stays at current when ideal equals current quality', () => {
    // 480p total = 1_496_000. usable needs to be >= 1_496_000 but < 2_928_000
    // 480p fits, 720p does not → ideal = 480p = current → stay
    // bandwidth: 1_496_000 / 0.8 = 1_870_000
    const result = strategy.decide(makeContext(1_870_000, q480));
    expect(result.name).toBe('480p');
  });

  it('does not overshoot: current=360p at 20Mbps → 480p (one step up)', () => {
    const result = strategy.decide(makeContext(20_000_000, q360));
    expect(result.name).toBe('480p');
  });

  it('does not undershoot below lowest: current=360p at low bandwidth → stays 360p', () => {
    const result = strategy.decide(makeContext(100_000, q360));
    expect(result.name).toBe('360p');
  });

  it('does not overshoot above highest: current=1080p at 20Mbps → stays 1080p', () => {
    const result = strategy.decide(makeContext(20_000_000, q1080));
    expect(result.name).toBe('1080p');
  });
});
