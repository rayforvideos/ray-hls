/**
 * Convert raw demuxed samples to formats required by fMP4/MSE.
 *
 * - Video: Annex B (start codes) → AVCC (length-prefixed NAL units)
 * - Audio: ADTS frames → raw AAC frames (strip ADTS header)
 */

import { DemuxedSample } from '../demuxer/ts-demuxer.js';

/**
 * Convert H.264 Annex B byte stream to AVCC format.
 * Replaces start codes (0x00000001 or 0x000001) with 4-byte big-endian NAL unit length.
 */
export function annexBToAVCC(data: Uint8Array): Uint8Array {
  const nalUnits: Uint8Array[] = [];
  let i = 0;

  while (i < data.length) {
    // Find start code
    let startCodeLen = 0;
    if (i + 3 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      startCodeLen = 4;
    } else if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      startCodeLen = 3;
    }

    if (startCodeLen === 0) {
      i++;
      continue;
    }

    const nalStart = i + startCodeLen;

    // Find next start code or end of data
    let nalEnd = data.length;
    for (let j = nalStart + 1; j < data.length - 2; j++) {
      if (data[j] === 0 && data[j + 1] === 0 &&
          (data[j + 2] === 1 || (j + 3 < data.length && data[j + 2] === 0 && data[j + 3] === 1))) {
        nalEnd = j;
        break;
      }
    }

    // Remove trailing zeros that belong to next start code
    while (nalEnd > nalStart && data[nalEnd - 1] === 0) {
      nalEnd--;
    }

    if (nalEnd > nalStart) {
      nalUnits.push(data.subarray(nalStart, nalEnd));
    }
    i = nalEnd;
  }

  // Calculate total size: 4 bytes length prefix per NAL + NAL data
  let totalSize = 0;
  for (const nal of nalUnits) {
    totalSize += 4 + nal.length;
  }

  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let offset = 0;

  for (const nal of nalUnits) {
    view.setUint32(offset, nal.length);
    offset += 4;
    result.set(nal, offset);
    offset += nal.length;
  }

  return result;
}

/**
 * Strip ADTS header from AAC frame, returning raw AAC data.
 * ADTS header is 7 bytes (no CRC) or 9 bytes (with CRC).
 */
export function stripADTSHeader(data: Uint8Array): Uint8Array {
  // Find and process all ADTS frames in the data
  const rawFrames: Uint8Array[] = [];
  let offset = 0;

  while (offset < data.length - 7) {
    // Check for ADTS sync word (0xFFF)
    if (data[offset] === 0xFF && (data[offset + 1] & 0xF0) === 0xF0) {
      const protectionAbsent = data[offset + 1] & 0x01;
      const headerSize = protectionAbsent ? 7 : 9;
      const frameLength = ((data[offset + 3] & 0x03) << 11) |
                          (data[offset + 4] << 3) |
                          ((data[offset + 5] >> 5) & 0x07);

      if (frameLength > headerSize && offset + frameLength <= data.length) {
        rawFrames.push(data.subarray(offset + headerSize, offset + frameLength));
        offset += frameLength;
        continue;
      }
    }
    offset++;
  }

  if (rawFrames.length === 0) {
    // No ADTS found, return as-is
    return data;
  }

  // Concatenate raw frames
  let totalLen = 0;
  for (const f of rawFrames) totalLen += f.length;
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const f of rawFrames) {
    result.set(f, pos);
    pos += f.length;
  }
  return result;
}

/**
 * Convert video samples: Annex B → AVCC
 */
export function convertVideoSamples(samples: DemuxedSample[]): DemuxedSample[] {
  return samples.map(s => ({
    ...s,
    data: annexBToAVCC(s.data),
  }));
}

/**
 * Convert audio samples: split each PES into individual AAC frames (strip ADTS headers).
 * One PES may contain multiple ADTS frames; each becomes a separate DemuxedSample
 * with PTS spaced by AAC_FRAME_DURATION (1024 samples / sampleRate * 90kHz).
 */
const AAC_FRAME_TICKS = Math.round(1024 / 44100 * 90000);

export function convertAudioSamples(samples: DemuxedSample[]): DemuxedSample[] {
  const out: DemuxedSample[] = [];
  for (const s of samples) {
    const frames = splitADTSFrames(s.data);
    if (frames.length === 0) {
      // No ADTS found, keep as-is
      out.push({ ...s, data: s.data });
      continue;
    }
    for (let i = 0; i < frames.length; i++) {
      out.push({
        pts: s.pts + i * AAC_FRAME_TICKS,
        data: frames[i],
      });
    }
  }
  return out;
}

/** Split ADTS byte stream into individual raw AAC frames (headers stripped). */
function splitADTSFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length - 7) {
    if (data[offset] === 0xFF && (data[offset + 1] & 0xF0) === 0xF0) {
      const protectionAbsent = data[offset + 1] & 0x01;
      const headerSize = protectionAbsent ? 7 : 9;
      const frameLength = ((data[offset + 3] & 0x03) << 11) |
                          (data[offset + 4] << 3) |
                          ((data[offset + 5] >> 5) & 0x07);
      if (frameLength > headerSize && offset + frameLength <= data.length) {
        frames.push(data.subarray(offset + headerSize, offset + frameLength));
        offset += frameLength;
        continue;
      }
    }
    offset++;
  }
  return frames;
}

// Keep old function for backward compat but it's unused now
export function _convertAudioSamplesOld(samples: DemuxedSample[]): DemuxedSample[] {
  return samples.map(s => ({
    ...s,
    data: stripADTSHeader(s.data),
  }));
}
