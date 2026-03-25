import { QualityLevel } from '../../shared/types.js';

export interface PrefetchConfig {
  bufferTarget: number; // 초 단위 (기본값 30)
}

export interface PrefetchInput {
  bufferLevel: number;      // 현재 버퍼 수준 (초)
  bandwidth: number;        // 측정된 대역폭 (bps)
  currentQuality: QualityLevel;
  nextSegmentIndex: number;
}

export interface PrefetchDecision {
  shouldFetch: boolean;
  segmentIndex?: number;
}

export class PrefetchEngine {
  private config: PrefetchConfig;

  constructor(config: PrefetchConfig) {
    this.config = config;
  }

  shouldPrefetch(input: PrefetchInput): PrefetchDecision {
    if (input.bufferLevel >= this.config.bufferTarget) {
      return { shouldFetch: false };
    }
    return { shouldFetch: true, segmentIndex: input.nextSegmentIndex };
  }

  getSpareBandwidth(currentBandwidth: number, currentQuality: QualityLevel): number {
    const required = currentQuality.videoBitrate + currentQuality.audioBitrate;
    return Math.max(0, currentBandwidth - required);
  }
}
