import { QualityLevel } from '../../shared/types.js';

export interface Measurement {
  segmentUrl: string;
  byteSize: number;
  downloadTimeMs: number;
  quality: QualityLevel;
}

export interface ABRContext {
  bandwidth: number;           // bps (비트/초)
  bufferLevel: number;         // 초 단위
  history: Measurement[];      // 최근 10개 세그먼트
  qualityLevels: QualityLevel[];
  currentQuality: QualityLevel;
}

export interface ABRStrategy {
  name: string;
  decide(context: ABRContext): QualityLevel;
}
