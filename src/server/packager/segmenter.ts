import {
  PTS_CLOCK_RATE,
  NAL_TYPE_IDR,
  NAL_TYPE_SPS,
  NAL_TYPE_PPS,
} from '../../shared/types.js';

export interface SegmenterResult {
  isNewSegment: boolean;
  completedSegmentDuration?: number; // seconds
  nalUnits: Buffer[];
}

/**
 * Parse an Annex B byte stream and extract individual NAL unit buffers
 * (without start codes).
 *
 * Supports both 3-byte (0x000001) and 4-byte (0x00000001) start codes.
 */
function parseAnnexB(data: Buffer): Buffer[] {
  const nalUnits: Buffer[] = [];
  let i = 0;
  const len = data.length;

  // Find the first start code
  let nalStart = -1;
  while (i < len - 2) {
    if (data[i] === 0x00 && data[i + 1] === 0x00) {
      if (data[i + 2] === 0x01) {
        // 3-byte start code
        if (nalStart !== -1) {
          nalUnits.push(data.subarray(nalStart, i));
        }
        i += 3;
        nalStart = i;
        continue;
      } else if (i + 3 < len && data[i + 2] === 0x00 && data[i + 3] === 0x01) {
        // 4-byte start code
        if (nalStart !== -1) {
          nalUnits.push(data.subarray(nalStart, i));
        }
        i += 4;
        nalStart = i;
        continue;
      }
    }
    i++;
  }

  // Capture trailing NAL unit
  if (nalStart !== -1 && nalStart < len) {
    nalUnits.push(data.subarray(nalStart, len));
  }

  return nalUnits;
}

export class Segmenter {
  /** Starts at -1; becomes 0 on the first IDR, increments on each subsequent IDR. */
  currentSegmentIndex: number = -1;

  /** Most recently seen SPS NAL unit (without start code), or null. */
  sps: Buffer | null = null;

  /** Most recently seen PPS NAL unit (without start code), or null. */
  pps: Buffer | null = null;

  /** PTS at which the current segment started (90kHz ticks). */
  private segmentStartPts: number = 0;

  /**
   * Push a chunk of Annex B encoded video data with its presentation timestamp.
   *
   * Returns a result indicating whether an IDR (new segment boundary) was
   * found, the duration of the completed segment (if any), and the list of
   * parsed NAL units.
   */
  pushVideoData(data: Buffer, pts: number): SegmenterResult {
    const nalUnits = parseAnnexB(data);

    let isNewSegment = false;
    let completedSegmentDuration: number | undefined;

    for (const nal of nalUnits) {
      if (nal.length === 0) continue;

      const nalType = nal[0] & 0x1F;

      if (nalType === NAL_TYPE_SPS) {
        this.sps = Buffer.from(nal);
      } else if (nalType === NAL_TYPE_PPS) {
        this.pps = Buffer.from(nal);
      } else if (nalType === NAL_TYPE_IDR) {
        // If this is not the very first IDR, calculate duration of the segment
        // that just completed.
        if (this.currentSegmentIndex >= 0) {
          completedSegmentDuration = (pts - this.segmentStartPts) / PTS_CLOCK_RATE;
        }
        this.currentSegmentIndex++;
        this.segmentStartPts = pts;
        isNewSegment = true;
      }
    }

    return { isNewSegment, completedSegmentDuration, nalUnits };
  }
}
