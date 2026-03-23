import { QualityLevel } from '../../shared/types.js';

export interface PrefetchConfig {
  bufferTarget: number; // seconds (default 30)
}

export interface PrefetchInput {
  bufferLevel: number;      // current buffer in seconds
  bandwidth: number;        // measured bps
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
