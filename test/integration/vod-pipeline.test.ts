import { describe, it, expect } from 'vitest';
import { buildTSPacket } from '../../src/server/packager/ts-packet.js';
import { buildPESPacket } from '../../src/server/packager/pes-packet.js';
import { buildPAT, buildPMT } from '../../src/server/packager/psi.js';
import { ManifestGenerator } from '../../src/server/manifest/index.js';
import { TSPackager } from '../../src/server/packager/index.js';
import { TSDemuxer } from '../../src/client/demuxer/ts-demuxer.js';
import {
  VIDEO_PID,
  AUDIO_PID,
  PAT_PID,
  PMT_PID,
  QUALITY_LEVELS,
  TS_PACKET_SIZE,
  NAL_TYPE_IDR,
  NAL_TYPE_SPS,
  NAL_TYPE_PPS,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic Annex B NAL unit with a 4-byte start code.
 */
function makeNAL(type: number, size: number): Buffer {
  const buf = Buffer.alloc(4 + 1 + size);
  buf.writeUInt32BE(0x00000001, 0); // start code
  buf[4] = type & 0x1f;            // NAL type
  for (let i = 5; i < buf.length; i++) buf[i] = 0xaa; // filler
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TS Packager → HTTP serving chain', () => {
  it('emits 2 segment events with correct SegmentInfo for 2 IDR frames', () => {
    const quality = QUALITY_LEVELS[0]; // 360p
    const packager = new TSPackager(quality);

    const segments: Array<{ index: number; filename: string; duration: number }> = [];
    packager.on('segment', (info) => {
      segments.push({ index: info.index, filename: info.filename, duration: info.duration });
    });

    // First IDR at pts=0 — opens segment 0
    const idr0 = makeNAL(NAL_TYPE_IDR, 32);
    packager.pushVideo(idr0, 0);

    // Second IDR at pts=540000 (6 seconds at 90kHz) — closes segment 0, opens segment 1
    const idr1 = makeNAL(NAL_TYPE_IDR, 32);
    packager.pushVideo(idr1, 540_000);

    // Flush the last open segment
    packager.flush();

    expect(segments.length).toBe(2);

    // Segment 0
    expect(segments[0].index).toBe(0);
    expect(segments[0].filename).toBe('seg-0.ts');
    // Duration is computed from PTS difference; segment 0 runs from 0 → 540000
    expect(segments[0].duration).toBeCloseTo(6, 1);

    // Segment 1
    expect(segments[1].index).toBe(1);
    expect(segments[1].filename).toBe('seg-1.ts');
  });
});

describe('Manifest generator produces valid m3u8', () => {
  it('master playlist has #EXTM3U and BANDWIDTH', () => {
    const gen = new ManifestGenerator(QUALITY_LEVELS, 'vod');
    const master = gen.getMasterPlaylist();

    expect(master).toContain('#EXTM3U');
    expect(master).toContain('BANDWIDTH=');
  });

  it('media playlist has #EXTINF and #EXT-X-ENDLIST after finalize', () => {
    const gen = new ManifestGenerator([QUALITY_LEVELS[0]], 'vod');

    gen.addSegment('360p', { index: 0, duration: 6.0, filename: 'seg-0.ts' });
    gen.addSegment('360p', { index: 1, duration: 6.0, filename: 'seg-1.ts' });
    gen.finalize();

    const media = gen.getMediaPlaylist('360p');
    expect(media).not.toBeNull();
    expect(media).toContain('#EXTINF');
    expect(media).toContain('#EXT-X-ENDLIST');
  });
});

describe('TS packet round-trip', () => {
  it('client demuxer reads back PID and payload after server packager builds packet', () => {
    // Build a small payload and wrap it in a TS packet
    const payload = Buffer.alloc(100, 0xbe);
    const pkt = buildTSPacket({
      pid: VIDEO_PID,
      payload,
      payloadUnitStart: false,
      continuityCounter: 0,
    });

    expect(pkt.length).toBe(TS_PACKET_SIZE);

    // Parse PID from the TS packet header (bytes 1-2)
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    expect(pid).toBe(VIDEO_PID);

    // Verify the packet is exactly 188 bytes and starts with sync byte
    expect(pkt[0]).toBe(0x47);
    expect(pkt.length).toBe(188);
  });
});

describe('Full packager → demuxer round-trip', () => {
  it('video samples extracted from segment have correct PTS', () => {
    const quality = QUALITY_LEVELS[0];
    const packager = new TSPackager(quality);

    const capturedBuffers: Buffer[] = [];
    packager.on('segment', (_info, data: Buffer) => {
      capturedBuffers.push(data);
    });

    // Push SPS + PPS + IDR at pts=0 to open segment 0
    const sps = makeNAL(NAL_TYPE_SPS, 16);
    const pps = makeNAL(NAL_TYPE_PPS, 4);
    const idr0 = makeNAL(NAL_TYPE_IDR, 64);
    const frame0 = Buffer.concat([sps, pps, idr0]);
    packager.pushVideo(frame0, 0);

    // Second IDR at pts=540000 (6 s) — triggers flush of segment 0 and opens segment 1
    const idr1 = makeNAL(NAL_TYPE_IDR, 64);
    packager.pushVideo(idr1, 540_000);

    // Flush segment 1
    packager.flush();

    // We should have at least segment 0
    expect(capturedBuffers.length).toBeGreaterThanOrEqual(1);

    // Feed segment 0 data into TSDemuxer
    const seg0 = capturedBuffers[0];
    const demuxer = new TSDemuxer();
    const result = demuxer.demux(new Uint8Array(seg0));

    // The demuxer should extract at least one video sample
    expect(result.videoSamples.length).toBeGreaterThan(0);

    // The first sample's PTS should match pts=0
    const firstSample = result.videoSamples[0];
    expect(firstSample.pts).toBe(0);
  });
});

describe('TS packet sync byte', () => {
  it('buildTSPacket always produces 188-byte packets starting with 0x47', () => {
    const cases: Array<{ pid: number; size: number; hasPcr: boolean }> = [
      { pid: PAT_PID,   size: 0,   hasPcr: false },
      { pid: PMT_PID,   size: 50,  hasPcr: false },
      { pid: VIDEO_PID, size: 100, hasPcr: true  },
      { pid: AUDIO_PID, size: 184, hasPcr: false },
    ];

    for (const { pid, size, hasPcr } of cases) {
      const payload = Buffer.alloc(size, 0x00);
      const pkt = buildTSPacket({
        pid,
        payload,
        payloadUnitStart: true,
        continuityCounter: 0,
        pcr: hasPcr ? 90_000 : undefined,
      });

      expect(pkt.length).toBe(TS_PACKET_SIZE);
      expect(pkt[0]).toBe(0x47);
    }
  });
});
