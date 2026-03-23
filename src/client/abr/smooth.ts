import { ABRContext, ABRStrategy } from './types.js';
import { QualityLevel } from '../../shared/types.js';

export class SmoothStrategy implements ABRStrategy {
  readonly name = 'smooth';

  decide(context: ABRContext): QualityLevel {
    const levels = context.qualityLevels;
    const usableBandwidth = context.bandwidth * 0.8;

    // Find the ideal level using 80% of bandwidth
    let ideal = levels[0];
    for (const level of levels) {
      const totalBitrate = level.videoBitrate + level.audioBitrate;
      if (totalBitrate <= usableBandwidth) {
        ideal = level;
      }
    }

    // Find current quality index
    const currentIndex = levels.findIndex(l => l.name === context.currentQuality.name);
    const idealIndex = levels.findIndex(l => l.name === ideal.name);

    // If ideal == current, stay
    if (idealIndex === currentIndex) {
      return levels[currentIndex];
    }

    // Limit change to ONE step from current quality
    if (idealIndex > currentIndex) {
      return levels[Math.min(currentIndex + 1, levels.length - 1)];
    } else {
      return levels[Math.max(currentIndex - 1, 0)];
    }
  }
}
