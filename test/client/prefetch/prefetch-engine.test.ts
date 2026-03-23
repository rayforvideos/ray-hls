import { describe, it, expect } from 'vitest';
import { PrefetchEngine } from '../../../src/client/prefetch/prefetch-engine.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';

const [q360, , q720] = QUALITY_LEVELS;
// q360: videoBitrate=800_000, audioBitrate=64_000 → total=864_000
// q720: videoBitrate=2_800_000, audioBitrate=128_000 → total=2_928_000

describe('PrefetchEngine', () => {
  describe('shouldPrefetch', () => {
    it('recommends prefetch when buffer is below target', () => {
      const engine = new PrefetchEngine({ bufferTarget: 30 });
      const decision = engine.shouldPrefetch({
        bufferLevel: 12,
        bandwidth: 5_000_000,
        currentQuality: q360,
        nextSegmentIndex: 5,
      });
      expect(decision.shouldFetch).toBe(true);
      expect(decision.segmentIndex).toBe(5);
    });

    it('does not prefetch when buffer is at target', () => {
      const engine = new PrefetchEngine({ bufferTarget: 30 });
      const decision = engine.shouldPrefetch({
        bufferLevel: 30,
        bandwidth: 5_000_000,
        currentQuality: q360,
        nextSegmentIndex: 7,
      });
      expect(decision.shouldFetch).toBe(false);
      expect(decision.segmentIndex).toBeUndefined();
    });

    it('does not prefetch when buffer is above target', () => {
      const engine = new PrefetchEngine({ bufferTarget: 30 });
      const decision = engine.shouldPrefetch({
        bufferLevel: 45,
        bandwidth: 5_000_000,
        currentQuality: q360,
        nextSegmentIndex: 10,
      });
      expect(decision.shouldFetch).toBe(false);
      expect(decision.segmentIndex).toBeUndefined();
    });

    it('still fetches even with low spare bandwidth (buffer is the primary signal)', () => {
      const engine = new PrefetchEngine({ bufferTarget: 30 });
      // bandwidth barely above quality bitrate — spare bandwidth is tiny
      const decision = engine.shouldPrefetch({
        bufferLevel: 5,
        bandwidth: 865_000, // just 1kbps spare over 864kbps total
        currentQuality: q360,
        nextSegmentIndex: 2,
      });
      expect(decision.shouldFetch).toBe(true);
      expect(decision.segmentIndex).toBe(2);
    });
  });

  describe('getSpareBandwidth', () => {
    it('calculates spare bandwidth correctly for 360p at 5Mbps', () => {
      const engine = new PrefetchEngine({ bufferTarget: 30 });
      // 5_000_000 - (800_000 + 64_000) = 5_000_000 - 864_000 = 4_136_000
      const spare = engine.getSpareBandwidth(5_000_000, q360);
      expect(spare).toBe(4_136_000);
    });

    it('returns 0 when bandwidth is less than quality total bitrate', () => {
      const engine = new PrefetchEngine({ bufferTarget: 30 });
      // q720 total = 2_928_000; bandwidth 1_000_000 < 2_928_000
      const spare = engine.getSpareBandwidth(1_000_000, q720);
      expect(spare).toBe(0);
    });

    it('returns 0 when bandwidth exactly equals quality total bitrate', () => {
      const engine = new PrefetchEngine({ bufferTarget: 30 });
      // q360 total = 864_000
      const spare = engine.getSpareBandwidth(864_000, q360);
      expect(spare).toBe(0);
    });
  });
});
