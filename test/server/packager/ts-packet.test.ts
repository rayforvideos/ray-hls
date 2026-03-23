import { describe, it, expect } from 'vitest';
import { buildTSPacket, TSPacketOptions } from '../../../src/server/packager/ts-packet.js';
import { TS_PACKET_SIZE } from '../../../src/shared/types.js';

describe('buildTSPacket', () => {
  const basePayload = Buffer.alloc(184, 0xAB); // exactly fills payload area

  function baseOpts(overrides: Partial<TSPacketOptions> = {}): TSPacketOptions {
    return {
      pid: 0x0100,
      payload: basePayload,
      payloadUnitStart: false,
      continuityCounter: 0,
      ...overrides,
    };
  }

  it('produces a 188-byte packet', () => {
    const pkt = buildTSPacket(baseOpts());
    expect(pkt.length).toBe(TS_PACKET_SIZE);
  });

  it('starts with sync byte 0x47', () => {
    const pkt = buildTSPacket(baseOpts());
    expect(pkt[0]).toBe(0x47);
  });

  it('encodes PID correctly in bytes 1-2', () => {
    // PID 0x0100 = 256
    const pkt = buildTSPacket(baseOpts({ pid: 0x0100 }));
    const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
    expect(pid).toBe(0x0100);
  });

  it('encodes a different PID correctly', () => {
    const pkt = buildTSPacket(baseOpts({ pid: 0x0101 }));
    const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
    expect(pid).toBe(0x0101);
  });

  it('encodes PAT PID (0x0000) correctly', () => {
    const pkt = buildTSPacket(baseOpts({ pid: 0x0000 }));
    const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
    expect(pid).toBe(0x0000);
  });

  it('sets payload_unit_start_indicator bit (bit 6 of byte 1) when requested', () => {
    const pkt = buildTSPacket(baseOpts({ payloadUnitStart: true }));
    const pusi = (pkt[1] >> 6) & 0x01;
    expect(pusi).toBe(1);
  });

  it('does not set payload_unit_start_indicator when not requested', () => {
    const pkt = buildTSPacket(baseOpts({ payloadUnitStart: false }));
    const pusi = (pkt[1] >> 6) & 0x01;
    expect(pusi).toBe(0);
  });

  it('encodes continuity counter in lower 4 bits of byte 3', () => {
    for (let cc = 0; cc < 16; cc++) {
      const pkt = buildTSPacket(baseOpts({ continuityCounter: cc }));
      const counter = pkt[3] & 0x0F;
      expect(counter).toBe(cc);
    }
  });

  it('pads with 0xFF stuffing when payload is smaller than 184 bytes', () => {
    const shortPayload = Buffer.alloc(100, 0xCC);
    const pkt = buildTSPacket(baseOpts({ payload: shortPayload }));

    expect(pkt.length).toBe(TS_PACKET_SIZE);

    // byte 3: adaptation_field_control bits [5:4]
    // 11 = adaptation + payload
    const afc = (pkt[3] >> 4) & 0x03;
    expect(afc).toBe(0x03); // adaptation + payload

    // adaptation field length is byte 4
    const afLen = pkt[4];
    // total = 4 (header) + 1 (afLen byte) + afLen + payload = 188
    // afLen = 188 - 4 - 1 - 100 = 83
    expect(afLen).toBe(83);

    // stuffing bytes start after adaptation field flags (byte 6 onward when no PCR)
    // adaptation field flags byte = pkt[5], rest are stuffing 0xFF
    for (let i = 6; i < 4 + 1 + afLen; i++) {
      expect(pkt[i]).toBe(0xFF);
    }
  });

  it('payload is written at correct offset when there is no adaptation field', () => {
    // Full 184-byte payload: header=4, payload=184, no adaptation field needed
    const pkt = buildTSPacket(baseOpts({ payload: basePayload }));
    const afc = (pkt[3] >> 4) & 0x03;
    // Should be payload-only (01)
    expect(afc).toBe(0x01);
    // Payload starts at byte 4
    expect(pkt[4]).toBe(0xAB);
    expect(pkt[187]).toBe(0xAB);
  });

  it('includes PCR in adaptation field when provided', () => {
    // PCR = 0 (simplest case)
    const pkt = buildTSPacket(baseOpts({ payload: Buffer.alloc(0), pcr: 0 }));
    expect(pkt.length).toBe(TS_PACKET_SIZE);

    const afc = (pkt[3] >> 4) & 0x03;
    // When payload is empty, adaptation only (10) or adaptation+payload (11)
    expect([0x02, 0x03]).toContain(afc);

    // adaptation field flags byte has PCR_flag set (bit 4)
    const afFlags = pkt[5];
    const pcrFlag = (afFlags >> 4) & 0x01;
    expect(pcrFlag).toBe(1);
  });

  it('encodes PCR value correctly in adaptation field', () => {
    // PCR base = 90000 (1 second at 90kHz), extension = 0
    const pcrValue = 90000;
    const payload = Buffer.alloc(100, 0x00);
    const pkt = buildTSPacket(baseOpts({ payload, pcr: pcrValue }));

    // PCR occupies 6 bytes starting at byte 6 (after afLen=pkt[4], afFlags=pkt[5])
    // PCR base is 33 bits: bytes[0..3] = base[32:1], byte[4][7] = base[0]
    // bits: base[32:25] | base[24:17] | base[16:9] | base[8:1] | base[0] | reserved(6) | ext[8] | ext[7:0]
    const b0 = pkt[6];
    const b1 = pkt[7];
    const b2 = pkt[8];
    const b3 = pkt[9];
    const b4 = pkt[10];
    // ext bytes
    const b5 = pkt[11];

    const pcrBase =
      (BigInt(b0) << 25n) |
      (BigInt(b1) << 17n) |
      (BigInt(b2) << 9n) |
      (BigInt(b3) << 1n) |
      BigInt((b4 >> 7) & 0x01);

    expect(pcrBase).toBe(BigInt(pcrValue));

    // reserved bits (bits 6:1 of b4) should be 1
    const reserved = (b4 >> 1) & 0x3F;
    expect(reserved).toBe(0x3F);

    // extension = 0
    const ext = ((b4 & 0x01) << 8) | b5;
    expect(ext).toBe(0);
  });

  it('sets TEI and priority bits to 0', () => {
    const pkt = buildTSPacket(baseOpts());
    // TEI = bit 7 of byte 1, priority = bit 5 of byte 1
    const tei = (pkt[1] >> 7) & 0x01;
    const priority = (pkt[1] >> 5) & 0x01;
    expect(tei).toBe(0);
    expect(priority).toBe(0);
  });

  it('sets scrambling bits to 00 in byte 3', () => {
    const pkt = buildTSPacket(baseOpts());
    const scrambling = (pkt[3] >> 6) & 0x03;
    expect(scrambling).toBe(0);
  });
});
