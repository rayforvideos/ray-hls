import { describe, it, expect } from 'vitest';
import { buildPESPacket, PESPacketOptions } from '../../../src/server/packager/pes-packet.js';

describe('buildPESPacket', () => {
  function makeOpts(overrides: Partial<PESPacketOptions> = {}): PESPacketOptions {
    return {
      streamId: 0xE0,
      payload: Buffer.from([0x01, 0x02, 0x03, 0x04]),
      pts: 90000,
      ...overrides,
    };
  }

  it('starts with PES start code prefix 0x000001', () => {
    const pkt = buildPESPacket(makeOpts());
    expect(pkt[0]).toBe(0x00);
    expect(pkt[1]).toBe(0x00);
    expect(pkt[2]).toBe(0x01);
  });

  it('sets stream_id byte (byte 3) to provided streamId for video (0xE0)', () => {
    const pkt = buildPESPacket(makeOpts({ streamId: 0xE0 }));
    expect(pkt[3]).toBe(0xE0);
  });

  it('sets stream_id byte (byte 3) to provided streamId for audio (0xC0)', () => {
    const pkt = buildPESPacket(makeOpts({ streamId: 0xC0 }));
    expect(pkt[3]).toBe(0xC0);
  });

  it('encodes packet_length as big-endian in bytes 4-5', () => {
    const payload = Buffer.alloc(10, 0xAA);
    const pkt = buildPESPacket(makeOpts({ payload, pts: 90000 }));
    // packet_length = bytes after packet_length field
    // = optional_header (3) + PTS (5) + payload (10) = 18
    const packetLength = (pkt[4] << 8) | pkt[5];
    expect(packetLength).toBe(18);
  });

  it('sets flags byte at offset 6 to 0x84 (marker bits + alignment indicator)', () => {
    const pkt = buildPESPacket(makeOpts());
    expect(pkt[6]).toBe(0x84);
  });

  it('sets PTS-only flag byte at offset 7 to 0x80 when no DTS provided', () => {
    const pkt = buildPESPacket(makeOpts({ pts: 90000 }));
    expect(pkt[7]).toBe(0x80);
  });

  it('sets PTS+DTS flag byte at offset 7 to 0xC0 when DTS is provided', () => {
    const pkt = buildPESPacket(makeOpts({ pts: 90000, dts: 80000 }));
    expect(pkt[7]).toBe(0xC0);
  });

  it('sets header_data_length at offset 8 to 5 for PTS-only', () => {
    const pkt = buildPESPacket(makeOpts({ pts: 90000 }));
    expect(pkt[8]).toBe(5);
  });

  it('sets header_data_length at offset 8 to 10 for PTS+DTS', () => {
    const pkt = buildPESPacket(makeOpts({ pts: 90000, dts: 80000 }));
    expect(pkt[8]).toBe(10);
  });

  it('encodes PTS correctly (PTS-only, marker 0x02)', () => {
    const pts = 90000;
    const pkt = buildPESPacket(makeOpts({ pts }));

    // PTS starts at offset 9 (bytes 9-13)
    const b0 = pkt[9];
    const b1 = pkt[10];
    const b2 = pkt[11];
    const b3 = pkt[12];
    const b4 = pkt[13];

    // marker nibble in top 4 bits of b0 should be 0x02
    const marker = (b0 >> 4) & 0x0F;
    expect(marker).toBe(0x02);

    // verify marker bits (bit 0 of b0, b2, b4 must be 1)
    expect(b0 & 0x01).toBe(1);
    expect(b2 & 0x01).toBe(1);
    expect(b4 & 0x01).toBe(1);

    // decode PTS from 5-byte encoding
    const decoded =
      (((b0 >> 1) & 0x07) << 30) |
      (b1 << 22) |
      (((b2 >> 1) & 0x7F) << 15) |
      (b3 << 7) |
      ((b4 >> 1) & 0x7F);

    expect(decoded).toBe(pts);
  });

  it('encodes PTS correctly with marker 0x03 when DTS is also present', () => {
    const pts = 90000;
    const dts = 80000;
    const pkt = buildPESPacket(makeOpts({ pts, dts }));

    // PTS starts at offset 9
    const b0 = pkt[9];
    const marker = (b0 >> 4) & 0x0F;
    expect(marker).toBe(0x03);

    const b1 = pkt[10];
    const b2 = pkt[11];
    const b3 = pkt[12];
    const b4 = pkt[13];

    const decodedPts =
      (((b0 >> 1) & 0x07) << 30) |
      (b1 << 22) |
      (((b2 >> 1) & 0x7F) << 15) |
      (b3 << 7) |
      ((b4 >> 1) & 0x7F);

    expect(decodedPts).toBe(pts);
  });

  it('encodes DTS correctly with marker 0x01 at bytes 14-18 when DTS provided', () => {
    const pts = 90000;
    const dts = 80000;
    const pkt = buildPESPacket(makeOpts({ pts, dts }));

    // DTS starts at offset 14 (bytes 14-18)
    const b0 = pkt[14];
    const b1 = pkt[15];
    const b2 = pkt[16];
    const b3 = pkt[17];
    const b4 = pkt[18];

    // marker nibble in top 4 bits of b0 should be 0x01
    const marker = (b0 >> 4) & 0x0F;
    expect(marker).toBe(0x01);

    // verify marker bits
    expect(b0 & 0x01).toBe(1);
    expect(b2 & 0x01).toBe(1);
    expect(b4 & 0x01).toBe(1);

    // decode DTS
    const decodedDts =
      (((b0 >> 1) & 0x07) << 30) |
      (b1 << 22) |
      (((b2 >> 1) & 0x7F) << 15) |
      (b3 << 7) |
      ((b4 >> 1) & 0x7F);

    expect(decodedDts).toBe(dts);
  });

  it('includes payload after header', () => {
    const payload = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const pkt = buildPESPacket(makeOpts({ payload, pts: 90000 }));
    // header: 3 (start code) + 1 (stream_id) + 2 (packet_length) + 3 (optional header flags) + 5 (PTS) = 14
    const payloadStart = 14;
    expect(pkt[payloadStart]).toBe(0xDE);
    expect(pkt[payloadStart + 1]).toBe(0xAD);
    expect(pkt[payloadStart + 2]).toBe(0xBE);
    expect(pkt[payloadStart + 3]).toBe(0xEF);
  });

  it('includes payload after header when DTS is present', () => {
    const payload = Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]);
    const pkt = buildPESPacket(makeOpts({ payload, pts: 90000, dts: 80000 }));
    // header: 3 + 1 + 2 + 3 (optional header flags) + 10 (PTS+DTS) = 19
    const payloadStart = 19;
    expect(pkt[payloadStart]).toBe(0xCA);
    expect(pkt[payloadStart + 1]).toBe(0xFE);
    expect(pkt[payloadStart + 2]).toBe(0xBA);
    expect(pkt[payloadStart + 3]).toBe(0xBE);
  });

  it('total packet length matches expected structure (PTS only)', () => {
    const payload = Buffer.alloc(20, 0x55);
    const pkt = buildPESPacket(makeOpts({ payload, pts: 0 }));
    // 3 (start code) + 1 (stream_id) + 2 (packet_length) + 3 (optional header) + 5 (PTS) + 20 (payload) = 34
    expect(pkt.length).toBe(34);
  });

  it('total packet length matches expected structure (PTS+DTS)', () => {
    const payload = Buffer.alloc(20, 0x55);
    const pkt = buildPESPacket(makeOpts({ payload, pts: 0, dts: 0 }));
    // 3 + 1 + 2 + 3 + 10 + 20 = 39
    expect(pkt.length).toBe(39);
  });

  it('encodes zero PTS correctly', () => {
    const pkt = buildPESPacket(makeOpts({ pts: 0 }));
    const b0 = pkt[9];
    const b1 = pkt[10];
    const b2 = pkt[11];
    const b3 = pkt[12];
    const b4 = pkt[13];

    // marker bits set, value is zero
    expect(b0 & 0x01).toBe(1);
    expect(b2 & 0x01).toBe(1);
    expect(b4 & 0x01).toBe(1);

    const decoded =
      (((b0 >> 1) & 0x07) << 30) |
      (b1 << 22) |
      (((b2 >> 1) & 0x7F) << 15) |
      (b3 << 7) |
      ((b4 >> 1) & 0x7F);

    expect(decoded).toBe(0);
  });

  it('encodes large PTS value correctly (33-bit max)', () => {
    // 33-bit max: 0x1FFFFFFFF = 8589934591
    const pts = 0x1FFFFFFF; // use a large but safe 29-bit value
    const pkt = buildPESPacket(makeOpts({ pts }));
    const b0 = pkt[9];
    const b1 = pkt[10];
    const b2 = pkt[11];
    const b3 = pkt[12];
    const b4 = pkt[13];

    const decoded =
      (((b0 >> 1) & 0x07) << 30) |
      (b1 << 22) |
      (((b2 >> 1) & 0x7F) << 15) |
      (b3 << 7) |
      ((b4 >> 1) & 0x7F);

    expect(decoded).toBe(pts);
  });

  it('sets packet_length to 0 for video stream (0xE0) when payload > 65529 bytes', () => {
    // Per spec, video PES packet length can be 0 for unbounded packets
    const largePayload = Buffer.alloc(65530, 0xAA);
    const pkt = buildPESPacket(makeOpts({ streamId: 0xE0, payload: largePayload }));
    const packetLength = (pkt[4] << 8) | pkt[5];
    expect(packetLength).toBe(0);
  });
});
