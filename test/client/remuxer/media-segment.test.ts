import { describe, it, expect } from 'vitest';
import { generateMediaSegment } from '../../../src/client/remuxer/media-segment.js';
import { DemuxedSample } from '../../../src/client/demuxer/ts-demuxer.js';

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

function makeSamples(count: number, ptsBasis: number, ptsStep: number): DemuxedSample[] {
  const samples: DemuxedSample[] = [];
  for (let i = 0; i < count; i++) {
    samples.push({
      pts: ptsBasis + i * ptsStep,
      data: new Uint8Array([0x00, 0x01, 0x02, 0x03]), // 4 bytes each
    });
  }
  return samples;
}

describe('media-segment', () => {
  it('output starts with moof box', () => {
    const video = makeSamples(3, 0, 3000);
    const audio = makeSamples(5, 0, 1024);
    const result = generateMediaSegment(1, video, audio, 0, 0);
    const type = readType(result, 4);
    expect(type).toBe('moof');
  });

  it('contains mdat box after moof', () => {
    const video = makeSamples(2, 0, 3000);
    const audio = makeSamples(2, 0, 1024);
    const result = generateMediaSegment(1, video, audio, 0, 0);
    const boxes = parseBoxes(result);
    expect(boxes.length).toBe(2);
    expect(boxes[0].type).toBe('moof');
    expect(boxes[1].type).toBe('mdat');
  });

  it('mfhd contains correct sequence number', () => {
    const video = makeSamples(1, 0, 3000);
    const result = generateMediaSegment(42, video, [], 0, 0);
    const boxes = parseBoxes(result);
    const moof = boxes[0];
    // mfhd is first child of moof
    const moofChildren = parseBoxes(result, moof.offset + 8, moof.offset + moof.size);
    const mfhd = moofChildren.find((b) => b.type === 'mfhd')!;
    expect(mfhd).toBeDefined();
    // mfhd: 8 (box header) + 4 (version+flags) + 4 (sequence_number)
    const seqNumOffset = mfhd.offset + 8 + 4; // past header and version/flags
    const seqNum = readUint32(result, seqNumOffset);
    expect(seqNum).toBe(42);
  });

  it('traf contains tfhd, tfdt, trun', () => {
    const video = makeSamples(3, 0, 3000);
    const result = generateMediaSegment(1, video, [], 90000, 0);
    const boxes = parseBoxes(result);
    const moof = boxes[0];
    const moofChildren = parseBoxes(result, moof.offset + 8, moof.offset + moof.size);
    const traf = moofChildren.find((b) => b.type === 'traf')!;
    expect(traf).toBeDefined();
    const trafChildren = parseBoxes(result, traf.offset + 8, traf.offset + traf.size);
    const types = trafChildren.map((b) => b.type);
    expect(types).toContain('tfhd');
    expect(types).toContain('tfdt');
    expect(types).toContain('trun');
  });

  it('trun sample count matches input', () => {
    const video = makeSamples(5, 0, 3000);
    const result = generateMediaSegment(1, video, [], 0, 0);
    const boxes = parseBoxes(result);
    const moof = boxes[0];
    const moofChildren = parseBoxes(result, moof.offset + 8, moof.offset + moof.size);
    const traf = moofChildren.find((b) => b.type === 'traf')!;
    const trafChildren = parseBoxes(result, traf.offset + 8, traf.offset + traf.size);
    const trunBox = trafChildren.find((b) => b.type === 'trun')!;
    // trun: 8 (header) + 4 (version/flags) + 4 (sample_count) ...
    const sampleCount = readUint32(result, trunBox.offset + 12);
    expect(sampleCount).toBe(5);
  });

  it('mdat size includes all sample data', () => {
    const video = makeSamples(3, 0, 3000);  // 3 * 4 = 12 bytes
    const audio = makeSamples(2, 0, 1024);  // 2 * 4 = 8 bytes
    const result = generateMediaSegment(1, video, audio, 0, 0);
    const boxes = parseBoxes(result);
    const mdat = boxes.find((b) => b.type === 'mdat')!;
    // mdat size = 8 (header) + 20 (data)
    expect(mdat.size).toBe(8 + 20);
  });

  it('handles empty video samples', () => {
    const audio = makeSamples(3, 0, 1024);
    const result = generateMediaSegment(1, [], audio, 0, 0);
    const boxes = parseBoxes(result);
    expect(boxes[0].type).toBe('moof');
    expect(boxes[1].type).toBe('mdat');
  });

  it('handles empty audio samples', () => {
    const video = makeSamples(2, 0, 3000);
    const result = generateMediaSegment(1, video, [], 0, 0);
    const boxes = parseBoxes(result);
    expect(boxes[0].type).toBe('moof');
    expect(boxes[1].type).toBe('mdat');
  });
});
