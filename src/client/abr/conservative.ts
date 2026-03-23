import { ABRContext, ABRStrategy } from './types.js';
import { QualityLevel } from '../../shared/types.js';

export class ConservativeStrategy implements ABRStrategy {
  readonly name = 'conservative';

  decide(context: ABRContext): QualityLevel {
    const usableBandwidth = context.bandwidth * 0.7;
    const levels = context.qualityLevels;

    // Select highest level where totalBitrate <= usableBandwidth
    let selected = levels[0];
    for (const level of levels) {
      const totalBitrate = level.videoBitrate + level.audioBitrate;
      if (totalBitrate <= usableBandwidth) {
        selected = level;
      }
    }

    return selected;
  }
}
