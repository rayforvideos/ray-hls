import { describe, it, expect } from 'vitest';
import { TSDemuxer } from '../../../src/client/demuxer/ts-demuxer.js';
import { parseNALUnits } from '../../../src/client/demuxer/nal-parser.js';
import { buildTSPacket } from '../../../src/server/packager/ts-packet.js';
import { buildPESPacket } from '../../../src/server/packager/pes-packet.js';
import { buildPAT, buildPMT } from '../../../src/server/packager/psi.js';
import {
  TS_PACKET_SIZE,
  PMT_PID as DEFAULT_PMT_PID,
  VIDEO_PID,
  AUDIO_PID,
  PTS_CLOCK_RATE,
  NAL_TYPE_IDR,
} from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Annex B buffer containing a single NAL unit of the given type. */
function makeNAL(type: number, payloadSize = 32): Buffer {
  const buf = Buffer.alloc(4 + 1 + payloadSize, 0xAB);
  buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0x01;
  buf[4] = type & 0x1F;
  return buf;
}

/** Build a simple AAC audio frame payload (raw bytes). */
function makeAAC(size = 64): Buffer {
  return Buffer.alloc(size, 0xAA);
}

/**
 * Build a minimal TS segment containing:
 *   - PAT (PID 0)
 *   - PMT (PID pmtPid)
 *   - Video PES (PID videoPid) with an IDR NAL unit
 *   - Audio PES (PID audioPid)
 *
 * Returns the raw segment as a Uint8Array (concatenated 188-byte TS packets).
 */
function buildMinimalSegment(opts: {
  pmtPid?: number;
  videoPid?: number;
  audioPid?: number;
  videoPts?: number;
  audioPts?: number;
}): Uint8Array {
  const pmtPid = opts.pmtPid ?? DEFAULT_PMT_PID;
  const videoPid = opts.videoPid ?? VIDEO_PID;
  const audioPid = opts.audioPid ?? AUDIO_PID;
  const videoPts = opts.videoPts ?? PTS_CLOCK_RATE; // 1 second
  const audioPts = opts.audioPts ?? PTS_CLOCK_RATE;

  const packets: Buffer[] = [];

  // PAT packet
  const patPayload = buildPAT(pmtPid);
  const patPointer = Buffer.alloc(1, 0x00); // pointer_field = 0
  const patWithPointer = Buffer.concat([patPointer, patPayload]);
  packets.push(
    buildTSPacket({
      pid: 0x0000,
      payload: patWithPointer,
      payloadUnitStart: true,
      continuityCounter: 0,
    }),
  );

  // PMT packet
  const pmtPayload = buildPMT(videoPid, audioPid);
  const pmtPointer = Buffer.alloc(1, 0x00); // pointer_field = 0
  const pmtWithPointer = Buffer.concat([pmtPointer, pmtPayload]);
  packets.push(
    buildTSPacket({
      pid: pmtPid,
      payload: pmtWithPointer,
      payloadUnitStart: true,
      continuityCounter: 0,
    }),
  );

  // Video PES packet (IDR NAL)
  const idrNal = makeNAL(NAL_TYPE_IDR, 64);
  const videoPES = buildPESPacket({
    streamId: 0xE0,
    payload: idrNal,
    pts: videoPts,
  });
  // Split PES across TS packets
  let cc = 0;
  let pesOffset = 0;
  let first = true;
  while (pesOffset < videoPES.length) {
    const maxPayload = TS_PACKET_SIZE - 4; // 184 bytes max (no adaptation field)
    const chunkSize = Math.min(maxPayload, videoPES.length - pesOffset);
    const chunk = videoPES.subarray(pesOffset, pesOffset + chunkSize);
    packets.push(
      buildTSPacket({
        pid: videoPid,
        payload: chunk,
        payloadUnitStart: first,
        continuityCounter: cc & 0x0F,
      }),
    );
    pesOffset += chunkSize;
    cc++;
    first = false;
  }

  // Audio PES packet
  const audioData = makeAAC(64);
  const audioPES = buildPESPacket({
    streamId: 0xC0,
    payload: audioData,
    pts: audioPts,
  });
  let acc = 0;
  let apesOffset = 0;
  let afirst = true;
  while (apesOffset < audioPES.length) {
    const maxPayload = TS_PACKET_SIZE - 4;
    const chunkSize = Math.min(maxPayload, audioPES.length - apesOffset);
    const chunk = audioPES.subarray(apesOffset, apesOffset + chunkSize);
    packets.push(
      buildTSPacket({
        pid: audioPid,
        payload: chunk,
        payloadUnitStart: afirst,
        continuityCounter: acc & 0x0F,
      }),
    );
    apesOffset += chunkSize;
    acc++;
    afirst = false;
  }

  return Buffer.concat(packets);
}

// ---------------------------------------------------------------------------
// Tests: TSDemuxer
// ---------------------------------------------------------------------------

describe('TSDemuxer', () => {
  it('discovers video PID from PAT/PMT', () => {
    const segment = buildMinimalSegment({ videoPts: PTS_CLOCK_RATE });
    const demuxer = new TSDemuxer();
    demuxer.demux(segment);
    expect(demuxer.videoPid).toBe(VIDEO_PID);
  });

  it('discovers audio PID from PAT/PMT', () => {
    const segment = buildMinimalSegment({ audioPts: PTS_CLOCK_RATE });
    const demuxer = new TSDemuxer();
    demuxer.demux(segment);
    expect(demuxer.audioPid).toBe(AUDIO_PID);
  });

  it('extracts at least one video sample', () => {
    const segment = buildMinimalSegment({ videoPts: PTS_CLOCK_RATE });
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(segment);
    expect(result.videoSamples.length).toBeGreaterThan(0);
  });

  it('extracts at least one audio sample', () => {
    const segment = buildMinimalSegment({ audioPts: PTS_CLOCK_RATE });
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(segment);
    expect(result.audioSamples.length).toBeGreaterThan(0);
  });

  it('video sample has correct PTS', () => {
    const expectedPts = PTS_CLOCK_RATE * 3; // 3 seconds
    const segment = buildMinimalSegment({ videoPts: expectedPts });
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(segment);
    expect(result.videoSamples[0].pts).toBe(expectedPts);
  });

  it('audio sample has correct PTS', () => {
    const expectedPts = PTS_CLOCK_RATE * 2; // 2 seconds
    const segment = buildMinimalSegment({ audioPts: expectedPts });
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(segment);
    expect(result.audioSamples[0].pts).toBe(expectedPts);
  });

  it('marks video sample containing IDR as keyframe', () => {
    const segment = buildMinimalSegment({ videoPts: PTS_CLOCK_RATE });
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(segment);
    expect(result.videoSamples[0].isKeyframe).toBe(true);
  });

  it('video sample data is non-empty', () => {
    const segment = buildMinimalSegment({ videoPts: PTS_CLOCK_RATE });
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(segment);
    expect(result.videoSamples[0].data.length).toBeGreaterThan(0);
  });

  it('audio sample data is non-empty', () => {
    const segment = buildMinimalSegment({ audioPts: PTS_CLOCK_RATE });
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(segment);
    expect(result.audioSamples[0].data.length).toBeGreaterThan(0);
  });

  it('skips packets with invalid sync byte', () => {
    const segment = buildMinimalSegment({ videoPts: PTS_CLOCK_RATE });
    // Corrupt first packet's sync byte
    const corrupted = Buffer.from(segment);
    corrupted[0] = 0x00;
    const demuxer = new TSDemuxer();
    // Should not throw even with a corrupted packet
    expect(() => demuxer.demux(corrupted)).not.toThrow();
  });

  it('handles empty input gracefully', () => {
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(new Uint8Array(0));
    expect(result.videoSamples).toHaveLength(0);
    expect(result.audioSamples).toHaveLength(0);
  });

  it('demuxes multiple segments sequentially', () => {
    const seg1 = buildMinimalSegment({ videoPts: PTS_CLOCK_RATE });
    const seg2 = buildMinimalSegment({ videoPts: PTS_CLOCK_RATE * 7 });
    const combined = Buffer.concat([Buffer.from(seg1), Buffer.from(seg2)]);
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(combined);
    // Each segment has one video PES, so expect 2 video samples total
    expect(result.videoSamples.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseNALUnits
// ---------------------------------------------------------------------------

describe('parseNALUnits', () => {
  it('parses a single NAL unit with 4-byte start code', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0xAB, 0xCD]);
    const units = parseNALUnits(data);
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe(5); // IDR (0x65 & 0x1F = 5)
  });

  it('parses a single NAL unit with 3-byte start code', () => {
    const data = new Uint8Array([0x00, 0x00, 0x01, 0x61, 0xAB]);
    const units = parseNALUnits(data);
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe(1); // non-IDR (0x61 & 0x1F = 1)
  });

  it('parses two NAL units separated by start codes', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x01, // SPS (type 7)
      0x00, 0x00, 0x00, 0x01, 0x68, 0x02, // PPS (type 8)
    ]);
    const units = parseNALUnits(data);
    expect(units).toHaveLength(2);
    expect(units[0].type).toBe(7);
    expect(units[1].type).toBe(8);
  });

  it('NAL unit data includes the type byte', () => {
    const data = new Uint8Array([0x00, 0x00, 0x01, 0x65, 0x11, 0x22]);
    const units = parseNALUnits(data);
    expect(units[0].data[0]).toBe(0x65);
  });

  it('returns empty array for data with no start codes', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const units = parseNALUnits(data);
    expect(units).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const units = parseNALUnits(new Uint8Array(0));
    expect(units).toHaveLength(0);
  });
});
