import { QualityLevel } from '../../shared/types.js';
import { ABRStrategy, ABRContext, Measurement } from './types.js';
import { ConservativeStrategy } from './conservative.js';
import { AggressiveStrategy } from './aggressive.js';
import { SmoothStrategy } from './smooth.js';

const MAX_HISTORY = 10;

export class ABREngine {
  private strategies: Map<string, ABRStrategy> = new Map();
  private strategy: ABRStrategy;
  private bandwidth: number = 0;
  private bufferLevel: number = 0;
  private history: Measurement[] = [];
  private qualityLevels: QualityLevel[];
  private currentQuality: QualityLevel;

  constructor(qualityLevels: QualityLevel[]) {
    this.qualityLevels = qualityLevels;
    this.currentQuality = qualityLevels[0];

    // Pre-register all 3 strategies
    const conservative = new ConservativeStrategy();
    const aggressive = new AggressiveStrategy();
    const smooth = new SmoothStrategy();

    this.strategies.set(conservative.name, conservative);
    this.strategies.set(aggressive.name, aggressive);
    this.strategies.set(smooth.name, smooth);

    // Default to conservative
    this.strategy = conservative;
  }

  get currentStrategyName(): string {
    return this.strategy.name;
  }

  setStrategy(name: string): void {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      throw new Error(`Unknown strategy: ${name}`);
    }
    this.strategy = strategy;
  }

  registerStrategy(strategy: ABRStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  updateBandwidth(bps: number): void {
    this.bandwidth = bps;
  }

  updateBufferLevel(seconds: number): void {
    this.bufferLevel = seconds;
  }

  recordMeasurement(m: Measurement): void {
    this.history.push(m);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
  }

  getHistory(): Measurement[] {
    return [...this.history];
  }

  decide(): QualityLevel {
    const context: ABRContext = {
      bandwidth: this.bandwidth,
      bufferLevel: this.bufferLevel,
      history: this.getHistory(),
      qualityLevels: this.qualityLevels,
      currentQuality: this.currentQuality,
    };

    const quality = this.strategy.decide(context);
    this.currentQuality = quality;
    return quality;
  }
}
