import { ABRContext, ABRStrategy } from './types.js';
import { QualityLevel } from '../../shared/types.js';

export class AggressiveStrategy implements ABRStrategy {
  readonly name = 'aggressive';

  decide(context: ABRContext): QualityLevel {
    const levels = context.qualityLevels;

    // 버퍼 수준이 5초 미만이면 최저 화질로 하락
    if (context.bufferLevel < 5) {
      return levels[0];
    }

    // 총 비트레이트가 대역폭 이하인 최고 화질 선택 (안전 마진 없이 100%)
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
