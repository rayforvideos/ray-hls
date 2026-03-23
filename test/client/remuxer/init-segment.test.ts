import { describe, it, expect } from 'vitest';
import { generateInitSegment, InitSegmentOptions } from '../../../src/client/remuxer/init-segment.js';

/** Read a 4-byte ASCII type at the given offset. */
function readType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/** Read a 4-byte big-endian uint at the given offset. */
function readUint32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset).getUint32(offset, false);
}

/** Find all top-level box types and their offsets/sizes in a buffer. */
function parseBoxes(data: Uint8Array, start = 0, end?: number): Array<{ type: string; offset: number; size: number }> {
  const boxes: Array<{ type: string; offset: number; size: number }> = [];
  let offset = start;
  const limit = end ?? data.length;
  while (offset + 8 <= limit) {
    const size = readUint32(data, offset);
    const type = readType(data, offset + 4);
    if (size < 8) break;
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

function defaultOpts(): InitSegmentOptions {
  return {
    width: 1920,
    height: 1080,
    sps: new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00]),
    pps: new Uint8Array([0x68, 0xce, 0x38, 0x80]),
    audioSampleRate: 44100,
    audioChannels: 2,
  };
}

describe('init-segment', () => {
  it('returns a valid Uint8Array', () => {
    const result = generateInitSegment(defaultOpts());
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(100);
  });

  it('starts with ftyp box', () => {
    const result = generateInitSegment(defaultOpts());
    const type = readType(result, 4);
    expect(type).toBe('ftyp');
  });

  it('contains moov box after ftyp', () => {
    const result = generateInitSegment(defaultOpts());
    const boxes = parseBoxes(result);
    expect(boxes.length).toBe(2);
    expect(boxes[0].type).toBe('ftyp');
    expect(boxes[1].type).toBe('moov');
  });

  it('moov contains mvhd, trak(s), and mvex', () => {
    const result = generateInitSegment(defaultOpts());
    const topBoxes = parseBoxes(result);
    const moov = topBoxes.find((b) => b.type === 'moov')!;
    const moovChildren = parseBoxes(result, moov.offset + 8, moov.offset + moov.size);
    const types = moovChildren.map((b) => b.type);
    expect(types).toContain('mvhd');
    expect(types).toContain('mvex');
    // With default 'both', we should have 2 traks
    const traks = moovChildren.filter((b) => b.type === 'trak');
    expect(traks.length).toBe(2);
  });

  it('trackType=video produces only video trak', () => {
    const opts = { ...defaultOpts(), trackType: 'video' as const };
    const result = generateInitSegment(opts);
    const topBoxes = parseBoxes(result);
    const moov = topBoxes.find((b) => b.type === 'moov')!;
    const moovChildren = parseBoxes(result, moov.offset + 8, moov.offset + moov.size);
    const traks = moovChildren.filter((b) => b.type === 'trak');
    expect(traks.length).toBe(1);
    // Check it's a video trak by looking for 'vide' handler type inside
    const trakData = result.slice(traks[0].offset, traks[0].offset + traks[0].size);
    const trakStr = new TextDecoder().decode(trakData);
    expect(trakStr).toContain('vide');
  });

  it('trackType=audio produces only audio trak', () => {
    const opts = { ...defaultOpts(), trackType: 'audio' as const };
    const result = generateInitSegment(opts);
    const topBoxes = parseBoxes(result);
    const moov = topBoxes.find((b) => b.type === 'moov')!;
    const moovChildren = parseBoxes(result, moov.offset + 8, moov.offset + moov.size);
    const traks = moovChildren.filter((b) => b.type === 'trak');
    expect(traks.length).toBe(1);
    const trakData = result.slice(traks[0].offset, traks[0].offset + traks[0].size);
    const trakStr = new TextDecoder().decode(trakData);
    expect(trakStr).toContain('soun');
  });

  it('mvex contains trex box(es)', () => {
    const result = generateInitSegment(defaultOpts());
    const topBoxes = parseBoxes(result);
    const moov = topBoxes.find((b) => b.type === 'moov')!;
    const moovChildren = parseBoxes(result, moov.offset + 8, moov.offset + moov.size);
    const mvex = moovChildren.find((b) => b.type === 'mvex')!;
    const mvexChildren = parseBoxes(result, mvex.offset + 8, mvex.offset + mvex.size);
    const trexBoxes = mvexChildren.filter((b) => b.type === 'trex');
    expect(trexBoxes.length).toBe(2);
  });
});
