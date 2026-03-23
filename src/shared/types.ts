export interface QualityLevel {
  name: string;           // '360p', '480p', '720p', '1080p'
  width: number;
  height: number;
  videoBitrate: number;   // bps
  audioBitrate: number;   // bps
}

export interface SegmentInfo {
  index: number;
  duration: number;       // seconds
  filename: string;       // e.g. 'seg-0.ts'
  quality: QualityLevel;
  byteSize: number;
}

export const QUALITY_LEVELS: QualityLevel[] = [
  { name: '360p',  width: 640,  height: 360,  videoBitrate: 800_000,  audioBitrate: 64_000  },
  { name: '480p',  width: 854,  height: 480,  videoBitrate: 1_400_000, audioBitrate: 96_000  },
  { name: '720p',  width: 1280, height: 720,  videoBitrate: 2_800_000, audioBitrate: 128_000 },
  { name: '1080p', width: 1920, height: 1080, videoBitrate: 5_000_000, audioBitrate: 192_000 },
];

export const TS_PACKET_SIZE = 188;
export const SEGMENT_DURATION = 6; // seconds
export const PTS_CLOCK_RATE = 90_000; // 90kHz

// MPEG-TS PIDs
export const PAT_PID = 0x0000;
export const PMT_PID = 0x1000;
export const VIDEO_PID = 0x0100;
export const AUDIO_PID = 0x0101;

// H.264 NAL unit types
export const NAL_TYPE_IDR = 5;
export const NAL_TYPE_NON_IDR = 1;
export const NAL_TYPE_SPS = 7;
export const NAL_TYPE_PPS = 8;

// MPEG-TS stream types
export const STREAM_TYPE_H264 = 0x1B;
export const STREAM_TYPE_AAC = 0x0F;
