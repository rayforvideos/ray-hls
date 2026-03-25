import { ABRContext, ABRStrategy } from './types.js';
import { QualityLevel } from '../../shared/types.js';

export class SmoothStrategy implements ABRStrategy {
  readonly name = 'smooth';

  decide(context: ABRContext): QualityLevel {
    const levels = context.qualityLevels;
    const usableBandwidth = context.bandwidth * 0.8;

    // 대역폭의 80%를 사용하여 이상적인 화질 수준 탐색
    let ideal = levels[0];
    for (const level of levels) {
      const totalBitrate = level.videoBitrate + level.audioBitrate;
      if (totalBitrate <= usableBandwidth) {
        ideal = level;
      }
    }

    // 현재 화질 인덱스 탐색
    const currentIndex = levels.findIndex(l => l.name === context.currentQuality.name);
    const idealIndex = levels.findIndex(l => l.name === ideal.name);

    // 이상적 화질이 현재와 같으면 유지
    if (idealIndex === currentIndex) {
      return levels[currentIndex];
    }

    // 현재 화질에서 한 단계만 변경하도록 제한
    if (idealIndex > currentIndex) {
      return levels[Math.min(currentIndex + 1, levels.length - 1)];
    } else {
      return levels[Math.max(currentIndex - 1, 0)];
    }
  }
}
