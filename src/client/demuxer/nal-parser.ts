export interface NALUnit {
  type: number;
  data: Uint8Array;
}

/**
 * Parse an Annex B byte stream, finding 3-byte (0x000001) and 4-byte
 * (0x00000001) start codes and extracting NAL units.
 *
 * NAL unit type = first byte of NAL data & 0x1F.
 */
export function parseNALUnits(data: Uint8Array): NALUnit[] {
  const units: NALUnit[] = [];
  const len = data.length;

  // Collect start code positions
  const startOffsets: number[] = []; // offset of the first NAL byte (after start code)

  let i = 0;
  while (i < len) {
    // Look for 0x000001 (3-byte) or 0x00000001 (4-byte) start code
    if (i + 2 < len && data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
      if (i > 0 && data[i - 1] === 0x00) {
        // 4-byte start code — NAL data starts at i+3
        startOffsets.push(i + 3);
      } else {
        // 3-byte start code
        startOffsets.push(i + 3);
      }
      i += 3;
      continue;
    }
    i++;
  }

  for (let j = 0; j < startOffsets.length; j++) {
    const start = startOffsets[j];
    // End is the byte before the next start code's leading zeros, or end of buffer.
    // The next startOffset was computed as the first byte after the start code prefix,
    // so we need to walk back past the zero bytes that precede the next start code.
    let end: number;
    if (j + 1 < startOffsets.length) {
      end = startOffsets[j + 1] - 3; // at minimum back 3 bytes for "001"
      // Also back off any leading 0x00 bytes (the fourth byte of a 4-byte start code)
      while (end > start && data[end - 1] === 0x00) {
        end--;
      }
    } else {
      end = len;
    }

    if (end > start) {
      const nalData = data.subarray(start, end);
      units.push({
        type: nalData[0] & 0x1F,
        data: nalData,
      });
    }
  }

  return units;
}
