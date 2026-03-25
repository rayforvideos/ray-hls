import { ABRContext, ABRStrategy } from './types.js';
import { QualityLevel } from '../../shared/types.js';

export class ConservativeStrategy implements ABRStrategy {
  readonly name = 'conservative';

  decide(context: ABRContext): QualityLevel {
    const usableBandwidth = context.bandwidth * 0.7;
    const levels = context.qualityLevels;

    // 총 비트레이트가 사용 가능 대역폭(70%) 이하인 최고 화질 선택
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
