import { ABRContext, ABRStrategy } from './types.js';
import { QualityLevel } from '../../shared/types.js';

export class AggressiveStrategy implements ABRStrategy {
  readonly name = 'aggressive';

  decide(context: ABRContext): QualityLevel {
    const levels = context.qualityLevels;

    // If bufferLevel < 5 seconds: drop to lowest
    if (context.bufferLevel < 5) {
      return levels[0];
    }

    // Highest level where totalBitrate <= bandwidth (100%, no safety margin)
    let selected = levels[0];
    for (const level of levels) {
      const totalBitrate = level.videoBitrate + level.audioBitrate;
      if (totalBitrate <= context.bandwidth) {
        selected = level;
      }
    }

    return selected;
  }
}
