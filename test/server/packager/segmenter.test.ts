import { describe, it, expect, beforeEach } from 'vitest';
import { Segmenter } from '../../../src/server/packager/segmenter.js';
import { PTS_CLOCK_RATE, NAL_TYPE_IDR, NAL_TYPE_NON_IDR, NAL_TYPE_SPS, NAL_TYPE_PPS } from '../../../src/shared/types.js';

/**
 * Build a minimal Annex B NAL unit buffer.
 * Format: 4-byte start code (0x00000001) + 1-byte NAL header + `size` payload bytes.
 */
function makeAnnexBNAL(type: number, size: number): Buffer {
  const buf = Buffer.alloc(4 + 1 + size);
  buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0x01;
  buf[4] = type & 0x1F;
  return buf;
}

describe('Segmenter', () => {
  let seg: Segmenter;

  beforeEach(() => {
    seg = new Segmenter();
  });

  // ----- initial state -----

  it('starts with currentSegmentIndex of -1', () => {
    expect(seg.currentSegmentIndex).toBe(-1);
  });

  it('starts with sps and pps as null', () => {
    expect(seg.sps).toBeNull();
    expect(seg.pps).toBeNull();
  });

  // ----- IDR detection -----

  it('detects an IDR NAL unit (type 5) as a new segment boundary', () => {
    const idr = makeAnnexBNAL(NAL_TYPE_IDR, 16);
    const result = seg.pushVideoData(idr, 0);
    expect(result.isNewSegment).toBe(true);
  });

  it('increments currentSegmentIndex to 0 on the first IDR', () => {
    const idr = makeAnnexBNAL(NAL_TYPE_IDR, 16);
    seg.pushVideoData(idr, 0);
    expect(seg.currentSegmentIndex).toBe(0);
  });

  it('increments currentSegmentIndex on each subsequent IDR', () => {
    seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 0);
    expect(seg.currentSegmentIndex).toBe(0);

    seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 90000);
    expect(seg.currentSegmentIndex).toBe(1);

    seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 180000);
    expect(seg.currentSegmentIndex).toBe(2);
  });

  // ----- non-IDR does NOT start a new segment -----

  it('does NOT set isNewSegment for a non-IDR NAL (type 1)', () => {
    const nonIdr = makeAnnexBNAL(NAL_TYPE_NON_IDR, 16);
    const result = seg.pushVideoData(nonIdr, 1000);
    expect(result.isNewSegment).toBe(false);
  });

  it('does not increment currentSegmentIndex on non-IDR data', () => {
    seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_NON_IDR, 4), 0);
    expect(seg.currentSegmentIndex).toBe(-1);
  });

  // ----- segment duration calculation -----

  it('does not include completedSegmentDuration on the first IDR', () => {
    const result = seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 0);
    expect(result.completedSegmentDuration).toBeUndefined();
  });

  it('calculates completedSegmentDuration in seconds from PTS difference on second IDR', () => {
    // First IDR at PTS 0
    seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 0);

    // Second IDR at PTS 90000 (= 1 second at 90kHz)
    const result = seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), PTS_CLOCK_RATE);
    expect(result.completedSegmentDuration).toBeCloseTo(1.0);
  });

  it('calculates completedSegmentDuration of 6 seconds for a typical HLS segment', () => {
    seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 0);
    const result = seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 6 * PTS_CLOCK_RATE);
    expect(result.completedSegmentDuration).toBeCloseTo(6.0);
  });

  it('calculates fractional segment duration correctly', () => {
    // 45000 ticks = 0.5 seconds
    seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 0);
    const result = seg.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 4), 45000);
    expect(result.completedSegmentDuration).toBeCloseTo(0.5);
  });

  // ----- SPS / PPS storage -----

  it('extracts and stores an SPS NAL unit (type 7)', () => {
    const sps = makeAnnexBNAL(NAL_TYPE_SPS, 20);
    seg.pushVideoData(sps, 0);
    expect(seg.sps).not.toBeNull();
  });

  it('stores the correct SPS buffer content', () => {
    const sps = makeAnnexBNAL(NAL_TYPE_SPS, 8);
    seg.pushVideoData(sps, 0);
    // The stored NAL should match the raw bytes (without start code)
    expect(seg.sps).toBeDefined();
    expect(seg.sps!.length).toBeGreaterThan(0);
    // First byte of the stored NAL unit should have NAL type 7
    expect(seg.sps![0] & 0x1F).toBe(NAL_TYPE_SPS);
  });

  it('extracts and stores a PPS NAL unit (type 8)', () => {
    const pps = makeAnnexBNAL(NAL_TYPE_PPS, 4);
    seg.pushVideoData(pps, 0);
    expect(seg.pps).not.toBeNull();
  });

  it('stores the correct PPS buffer content', () => {
    const pps = makeAnnexBNAL(NAL_TYPE_PPS, 4);
    seg.pushVideoData(pps, 0);
    expect(seg.pps).toBeDefined();
    expect(seg.pps!.length).toBeGreaterThan(0);
    expect(seg.pps![0] & 0x1F).toBe(NAL_TYPE_PPS);
  });

  it('updates stored SPS when a new SPS arrives', () => {
    const sps1 = makeAnnexBNAL(NAL_TYPE_SPS, 8);
    const sps2 = makeAnnexBNAL(NAL_TYPE_SPS, 16); // larger SPS
    seg.pushVideoData(sps1, 0);
    seg.pushVideoData(sps2, 1000);
    expect(seg.sps!.length).toBe(1 + 16); // 1 header byte + 16 payload bytes
  });

  // ----- NAL units returned -----

  it('returns the parsed NAL units in the result', () => {
    const idr = makeAnnexBNAL(NAL_TYPE_IDR, 8);
    const result = seg.pushVideoData(idr, 0);
    expect(result.nalUnits.length).toBeGreaterThan(0);
    expect(result.nalUnits[0][0] & 0x1F).toBe(NAL_TYPE_IDR);
  });

  it('returns multiple NAL units when the buffer contains more than one', () => {
    // Build a buffer with SPS + PPS + IDR concatenated
    const sps = makeAnnexBNAL(NAL_TYPE_SPS, 8);
    const pps = makeAnnexBNAL(NAL_TYPE_PPS, 4);
    const idr = makeAnnexBNAL(NAL_TYPE_IDR, 16);
    const combined = Buffer.concat([sps, pps, idr]);

    const result = seg.pushVideoData(combined, 0);
    expect(result.nalUnits.length).toBe(3);
    expect(result.nalUnits[0][0] & 0x1F).toBe(NAL_TYPE_SPS);
    expect(result.nalUnits[1][0] & 0x1F).toBe(NAL_TYPE_PPS);
    expect(result.nalUnits[2][0] & 0x1F).toBe(NAL_TYPE_IDR);
  });

  it('handles 3-byte start codes (0x000001) in addition to 4-byte (0x00000001)', () => {
    // Build a NAL with a 3-byte start code
    const buf = Buffer.alloc(3 + 1 + 8);
    buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x01;
    buf[3] = NAL_TYPE_IDR & 0x1F;
    // rest is zero payload

    const result = seg.pushVideoData(buf, 0);
    expect(result.isNewSegment).toBe(true);
    expect(result.nalUnits.length).toBe(1);
    expect(result.nalUnits[0][0] & 0x1F).toBe(NAL_TYPE_IDR);
  });

  it('isNewSegment is false when buffer contains no IDR', () => {
    const sps = makeAnnexBNAL(NAL_TYPE_SPS, 8);
    const pps = makeAnnexBNAL(NAL_TYPE_PPS, 4);
    const combined = Buffer.concat([sps, pps]);
    const result = seg.pushVideoData(combined, 0);
    expect(result.isNewSegment).toBe(false);
  });
});
