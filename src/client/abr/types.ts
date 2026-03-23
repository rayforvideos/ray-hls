import { QualityLevel } from '../../shared/types.js';

export interface Measurement {
  segmentUrl: string;
  byteSize: number;
  downloadTimeMs: number;
  quality: QualityLevel;
}

export interface ABRContext {
  bandwidth: number;           // bps
  bufferLevel: number;         // seconds
  history: Measurement[];      // last 10 segments
  qualityLevels: QualityLevel[];
  currentQuality: QualityLevel;
}

export interface ABRStrategy {
  name: string;
  decide(context: ABRContext): QualityLevel;
}
