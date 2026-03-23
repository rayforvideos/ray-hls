import { describe, it, expect, beforeEach } from 'vitest';
import { TSPackager } from '../../../src/server/packager/index.js';
import {
  TS_PACKET_SIZE, QualityLevel, SegmentInfo,
  PAT_PID, PMT_PID, VIDEO_PID, AUDIO_PID,
  PTS_CLOCK_RATE, NAL_TYPE_IDR, NAL_TYPE_NON_IDR, NAL_TYPE_SPS, NAL_TYPE_PPS,
} from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_QUALITY: QualityLevel = {
  name: '720p',
  width: 1280,
  height: 720,
  videoBitrate: 2_800_000,
  audioBitrate: 128_000,
};

/** Build a minimal Annex B buffer containing a single NAL unit of the given type. */
function makeNAL(type: number, payloadSize = 16): Buffer {
  const buf = Buffer.alloc(4 + 1 + payloadSize, 0xAB);
  buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0x01;
  buf[4] = type & 0x1F;
  return buf;
}

/** Build a simple ADTS AAC frame (7-byte header + payload). */
function makeAAC(payloadSize = 64): Buffer {
  const frameLen = 7 + payloadSize;
  const buf = Buffer.alloc(frameLen, 0x00);
  // ADTS sync word
  buf[0] = 0xFF; buf[1] = 0xF1;
  // frame length in bits 30-13
  buf[3] = (frameLen >> 11) & 0x03;
  buf[4] = (frameLen >> 3) & 0xFF;
  buf[5] = ((frameLen & 0x07) << 5) | 0x1F;
  buf[6] = 0xFC;
  return buf;
}

/** Extract the PID encoded in bytes 1-2 of a 188-byte TS packet. */
function readPID(pkt: Buffer): number {
  return ((pkt[1] & 0x1F) << 8) | pkt[2];
}

/** Collect all emitted segment events from a packager into an array. */
function collectSegments(pkgr: TSPackager): Array<{ info: SegmentInfo; data: Buffer }> {
  const results: Array<{ info: SegmentInfo; data: Buffer }> = [];
  pkgr.on('segment', (info: SegmentInfo, data: Buffer) => {
    results.push({ info, data });
  });
  return results;
}

/** Split a flat TS segment buffer into individual 188-byte packets. */
function splitPackets(data: Buffer): Buffer[] {
  const pkts: Buffer[] = [];
  for (let i = 0; i + TS_PACKET_SIZE <= data.length; i += TS_PACKET_SIZE) {
    pkts.push(data.subarray(i, i + TS_PACKET_SIZE));
  }
  return pkts;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TSPackager', () => {
  let pkgr: TSPackager;

  beforeEach(() => {
    pkgr = new TSPackager(TEST_QUALITY);
  });

  // --- Sync byte on every packet ---

  it('every TS packet in a segment starts with sync byte 0x47', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    expect(segments).toHaveLength(1);
    const pkts = splitPackets(segments[0].data);
    expect(pkts.length).toBeGreaterThan(0);
    for (const pkt of pkts) {
      expect(pkt[0]).toBe(0x47);
    }
  });

  // --- PAT and PMT at segment start ---

  it('segment data starts with a PAT packet (PID 0x0000)', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    // First packet must be PAT
    expect(pkts[0][0]).toBe(0x47);
    expect(readPID(pkts[0])).toBe(PAT_PID);
  });

  it('second packet of segment is a PMT packet (PID 0x1000)', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    expect(pkts[1][0]).toBe(0x47);
    expect(readPID(pkts[1])).toBe(PMT_PID);
  });

  it('PAT packet has payload_unit_start_indicator set', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const patPkt = splitPackets(segments[0].data)[0];
    const pusi = (patPkt[1] >> 6) & 0x01;
    expect(pusi).toBe(1);
  });

  it('PMT packet has payload_unit_start_indicator set', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pmtPkt = splitPackets(segments[0].data)[1];
    const pusi = (pmtPkt[1] >> 6) & 0x01;
    expect(pusi).toBe(1);
  });

  // --- Video PES packetization ---

  it('video data produces TS packets with VIDEO_PID (0x0100)', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    const videoPkts = pkts.filter(p => readPID(p) === VIDEO_PID);
    expect(videoPkts.length).toBeGreaterThan(0);
  });

  it('first video TS packet has payload_unit_start_indicator set', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    const firstVideoPkt = pkts.find(p => readPID(p) === VIDEO_PID)!;
    const pusi = (firstVideoPkt[1] >> 6) & 0x01;
    expect(pusi).toBe(1);
  });

  it('large video frame is split across multiple TS packets', () => {
    const segments = collectSegments(pkgr);

    // A 1000-byte payload will require multiple TS packets
    const bigFrame = makeNAL(NAL_TYPE_IDR, 1000);
    pkgr.pushVideo(bigFrame, 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    const videoPkts = pkts.filter(p => readPID(p) === VIDEO_PID);
    expect(videoPkts.length).toBeGreaterThan(1);
  });

  it('all TS packets in a segment are exactly 188 bytes', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR, 500), 0);
    pkgr.pushAudio(makeAAC(128), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    expect(segments[0].data.length % TS_PACKET_SIZE).toBe(0);
  });

  // --- Audio PES packetization ---

  it('audio data produces TS packets with AUDIO_PID (0x0101)', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushAudio(makeAAC(), 1000);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    const audioPkts = pkts.filter(p => readPID(p) === AUDIO_PID);
    expect(audioPkts.length).toBeGreaterThan(0);
  });

  it('first audio TS packet has payload_unit_start_indicator set', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushAudio(makeAAC(), 1000);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    const firstAudioPkt = pkts.find(p => readPID(p) === AUDIO_PID)!;
    const pusi = (firstAudioPkt[1] >> 6) & 0x01;
    expect(pusi).toBe(1);
  });

  it('audio before first IDR is silently discarded', () => {
    const segments = collectSegments(pkgr);

    // Push audio before any IDR — should not throw and no segment yet
    pkgr.pushAudio(makeAAC(), 0);
    expect(segments).toHaveLength(0);

    // Now start a real segment
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);
    expect(segments).toHaveLength(1);
  });

  // --- SegmentInfo correctness ---

  it('emitted SegmentInfo has index 0 for the first segment', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    expect(segments[0].info.index).toBe(0);
  });

  it('emitted SegmentInfo filename follows seg-{index}.ts pattern', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    expect(segments[0].info.filename).toBe('seg-0.ts');
  });

  it('emitted SegmentInfo carries the correct QualityLevel', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    expect(segments[0].info.quality).toEqual(TEST_QUALITY);
  });

  it('emitted SegmentInfo duration approximates elapsed PTS time in seconds', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6); // 6-second segment

    expect(segments[0].info.duration).toBeCloseTo(6.0, 3);
  });

  it('emitted SegmentInfo byteSize matches the byte length of the data buffer', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    expect(segments[0].info.byteSize).toBe(segments[0].data.length);
  });

  // --- Multiple segments and incrementing indices ---

  it('multiple IDRs produce multiple segments with incrementing indices', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 12);

    expect(segments).toHaveLength(2);
    expect(segments[0].info.index).toBe(0);
    expect(segments[1].info.index).toBe(1);
  });

  it('filenames for multiple segments follow seg-0.ts, seg-1.ts, …', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 12);

    expect(segments[0].info.filename).toBe('seg-0.ts');
    expect(segments[1].info.filename).toBe('seg-1.ts');
  });

  it('each new segment restarts with PAT then PMT', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 12);

    for (const seg of segments) {
      const pkts = splitPackets(seg.data);
      expect(readPID(pkts[0])).toBe(PAT_PID);
      expect(readPID(pkts[1])).toBe(PMT_PID);
    }
  });

  // --- Continuity counters ---

  it('video continuity counter increments across packets in the same PES', () => {
    const segments = collectSegments(pkgr);

    // Large frame so it spans multiple TS packets
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR, 800), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    const videoPkts = pkts.filter(p => readPID(p) === VIDEO_PID);
    expect(videoPkts.length).toBeGreaterThanOrEqual(2);

    // CCs should be strictly sequential (mod 16)
    const cc0 = videoPkts[0][3] & 0x0F;
    const cc1 = videoPkts[1][3] & 0x0F;
    expect(cc1).toBe((cc0 + 1) & 0x0F);
  });

  it('video continuity counter wraps around at 16', () => {
    const segments = collectSegments(pkgr);

    // Push 17 video frames to force CC wrap (each frame generates at least one TS packet)
    const PTS_STEP = 3000; // small step so all within one segment
    let pts = 0;
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), pts);
    for (let i = 1; i < 17; i++) {
      pts += PTS_STEP;
      pkgr.pushVideo(makeNAL(NAL_TYPE_NON_IDR), pts);
    }
    // Flush the segment with a second IDR
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    const videoPkts = pkts.filter(p => readPID(p) === VIDEO_PID);

    // Collect all CCs and verify they are sequential mod 16
    let expectedCC = videoPkts[0][3] & 0x0F;
    for (const pkt of videoPkts) {
      expect(pkt[3] & 0x0F).toBe(expectedCC);
      expectedCC = (expectedCC + 1) & 0x0F;
    }
  });

  it('audio continuity counter increments correctly', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    // Large audio frame to force multiple packets
    pkgr.pushAudio(makeAAC(600), 1000);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);

    const pkts = splitPackets(segments[0].data);
    const audioPkts = pkts.filter(p => readPID(p) === AUDIO_PID);
    expect(audioPkts.length).toBeGreaterThanOrEqual(2);

    const cc0 = audioPkts[0][3] & 0x0F;
    const cc1 = audioPkts[1][3] & 0x0F;
    expect(cc1).toBe((cc0 + 1) & 0x0F);
  });

  it('PAT and PMT continuity counters increment across segments', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 12);

    const seg0Pkts = splitPackets(segments[0].data);
    const seg1Pkts = splitPackets(segments[1].data);

    const patCC0 = seg0Pkts[0][3] & 0x0F; // PAT is first packet
    const patCC1 = seg1Pkts[0][3] & 0x0F;
    expect(patCC1).toBe((patCC0 + 1) & 0x0F);

    const pmtCC0 = seg0Pkts[1][3] & 0x0F; // PMT is second packet
    const pmtCC1 = seg1Pkts[1][3] & 0x0F;
    expect(pmtCC1).toBe((pmtCC0 + 1) & 0x0F);
  });

  // --- flush() ---

  it('flush() emits the final incomplete segment', () => {
    const segments = collectSegments(pkgr);

    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_NON_IDR), PTS_CLOCK_RATE * 3);
    // No second IDR — flush manually
    pkgr.flush();

    expect(segments).toHaveLength(1);
    expect(segments[0].info.index).toBe(0);
    expect(segments[0].info.filename).toBe('seg-0.ts');
  });

  it('flush() on empty packager (no IDR yet) emits nothing', () => {
    const segments = collectSegments(pkgr);
    pkgr.flush();
    expect(segments).toHaveLength(0);
  });

  it('flush() emits the buffered-but-unclosed segment started by the last IDR', () => {
    const segments = collectSegments(pkgr);

    // IDR 0 starts seg-0; IDR 1 flushes seg-0 and starts seg-1
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), 0);
    pkgr.pushVideo(makeNAL(NAL_TYPE_IDR), PTS_CLOCK_RATE * 6);
    expect(segments).toHaveLength(1); // seg-0 emitted

    // seg-1 is now buffered (has PAT+PMT+video packets). flush() must emit it.
    pkgr.flush();
    expect(segments).toHaveLength(2);
    expect(segments[1].info.index).toBe(1);
    expect(segments[1].info.filename).toBe('seg-1.ts');
  });

  // --- Re-exports ---

  it('re-exports Segmenter from the index', async () => {
    const mod = await import('../../../src/server/packager/index.js');
    expect(mod.Segmenter).toBeDefined();
  });

  it('re-exports buildTSPacket from the index', async () => {
    const mod = await import('../../../src/server/packager/index.js');
    expect(mod.buildTSPacket).toBeDefined();
  });

  it('re-exports buildPESPacket from the index', async () => {
    const mod = await import('../../../src/server/packager/index.js');
    expect(mod.buildPESPacket).toBeDefined();
  });

  it('re-exports buildPAT and buildPMT from the index', async () => {
    const mod = await import('../../../src/server/packager/index.js');
    expect(mod.buildPAT).toBeDefined();
    expect(mod.buildPMT).toBeDefined();
  });
});
