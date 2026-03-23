import { describe, it, expect } from 'vitest';
import { ABREngine } from '../../../src/client/abr/abr-engine.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';
import { ABRStrategy, ABRContext, Measurement } from '../../../src/client/abr/types.js';

const [q360, q480, q720, q1080] = QUALITY_LEVELS;

function makeMeasurement(index: number): Measurement {
  return {
    segmentUrl: `seg-${index}.ts`,
    byteSize: 1000 * index,
    downloadTimeMs: 100,
    quality: q360,
  };
}

describe('ABREngine', () => {
  describe('initialization', () => {
    it('defaults to conservative strategy', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      expect(engine.currentStrategyName).toBe('conservative');
    });

    it('uses the provided quality levels', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.updateBandwidth(20_000_000);
      const quality = engine.decide();
      expect(quality.name).toBe('1080p');
    });
  });

  describe('setStrategy', () => {
    it('switches to aggressive strategy', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.setStrategy('aggressive');
      expect(engine.currentStrategyName).toBe('aggressive');
    });

    it('switches to smooth strategy', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.setStrategy('smooth');
      expect(engine.currentStrategyName).toBe('smooth');
    });

    it('switches back to conservative', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.setStrategy('aggressive');
      engine.setStrategy('conservative');
      expect(engine.currentStrategyName).toBe('conservative');
    });

    it('throws on unknown strategy name', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      expect(() => engine.setStrategy('unknown')).toThrow('Unknown strategy: unknown');
    });
  });

  describe('registerStrategy', () => {
    it('registers a custom strategy and allows switching to it', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      const custom: ABRStrategy = {
        name: 'custom',
        decide: (_ctx: ABRContext) => q720,
      };
      engine.registerStrategy(custom);
      engine.setStrategy('custom');
      expect(engine.currentStrategyName).toBe('custom');
    });

    it('custom strategy decide is called by engine', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      const custom: ABRStrategy = {
        name: 'always-720p',
        decide: (_ctx: ABRContext) => q720,
      };
      engine.registerStrategy(custom);
      engine.setStrategy('always-720p');
      const quality = engine.decide();
      expect(quality.name).toBe('720p');
    });
  });

  describe('updateBandwidth and updateBufferLevel', () => {
    it('aggressive drops to lowest when buffer < 5 even at high bandwidth', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.setStrategy('aggressive');
      engine.updateBandwidth(20_000_000);
      engine.updateBufferLevel(2);
      const quality = engine.decide();
      expect(quality.name).toBe('360p');
    });

    it('aggressive picks 1080p at high bandwidth and buffer >= 5', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.setStrategy('aggressive');
      engine.updateBandwidth(20_000_000);
      engine.updateBufferLevel(15);
      const quality = engine.decide();
      expect(quality.name).toBe('1080p');
    });
  });

  describe('recordMeasurement and getHistory', () => {
    it('records measurements and returns a copy via getHistory', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      const m = makeMeasurement(1);
      engine.recordMeasurement(m);
      const history = engine.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].segmentUrl).toBe('seg-1.ts');
    });

    it('getHistory returns a copy, not internal reference', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.recordMeasurement(makeMeasurement(1));
      const history = engine.getHistory();
      history.push(makeMeasurement(99));
      expect(engine.getHistory()).toHaveLength(1);
    });

    it('keeps only last 10 measurements (FIFO)', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      for (let i = 1; i <= 12; i++) {
        engine.recordMeasurement(makeMeasurement(i));
      }
      const history = engine.getHistory();
      expect(history).toHaveLength(10);
      expect(history[0].segmentUrl).toBe('seg-3.ts');
      expect(history[9].segmentUrl).toBe('seg-12.ts');
    });
  });

  describe('decide', () => {
    it('returns a QualityLevel', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.updateBandwidth(3_000_000);
      const quality = engine.decide();
      expect(quality).toHaveProperty('name');
      expect(quality).toHaveProperty('videoBitrate');
    });

    it('updates currentQuality after decide', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      engine.updateBandwidth(3_000_000);
      const q1 = engine.decide(); // conservative: 480p
      expect(q1.name).toBe('480p');

      // Smooth strategy uses currentQuality; at 20Mbps from 480p → 720p
      engine.setStrategy('smooth');
      engine.updateBandwidth(20_000_000);
      const q2 = engine.decide();
      expect(q2.name).toBe('720p');
    });

    it('passes history to strategy context', () => {
      const engine = new ABREngine(QUALITY_LEVELS);
      let capturedHistory: Measurement[] = [];
      const spy: ABRStrategy = {
        name: 'spy',
        decide: (ctx: ABRContext) => {
          capturedHistory = ctx.history;
          return ctx.qualityLevels[0];
        },
      };
      engine.registerStrategy(spy);
      engine.setStrategy('spy');
      engine.recordMeasurement(makeMeasurement(1));
      engine.recordMeasurement(makeMeasurement(2));
      engine.decide();
      expect(capturedHistory).toHaveLength(2);
    });
  });
});
