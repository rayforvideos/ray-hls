import { describe, it, expect } from 'vitest';
import { validateC0, generateS0S1S2 } from '../../../../src/server/ingest/rtmp/handshake.js';

describe('validateC0', () => {
  it('returns true for version 0x03', () => {
    const buf = Buffer.from([0x03]);
    expect(validateC0(buf)).toBe(true);
  });

  it('returns false for version 0x04', () => {
    const buf = Buffer.from([0x04]);
    expect(validateC0(buf)).toBe(false);
  });

  it('returns false for version 0x00', () => {
    const buf = Buffer.from([0x00]);
    expect(validateC0(buf)).toBe(false);
  });
});

describe('generateS0S1S2', () => {
  it('returns a buffer of exactly 3073 bytes', () => {
    const c1 = Buffer.alloc(1536, 0xab);
    const result = generateS0S1S2(c1);
    expect(result.length).toBe(3073);
  });

  it('sets S0 version byte to 0x03', () => {
    const c1 = Buffer.alloc(1536, 0xab);
    const result = generateS0S1S2(c1);
    expect(result[0]).toBe(0x03);
  });

  it('S2 echoes C1 data in the first 4 bytes', () => {
    const c1 = Buffer.alloc(1536);
    // Set known timestamp in C1 bytes 0-3
    c1.writeUInt32BE(0x12345678, 0);
    // Set some recognizable data in bytes 8+
    for (let i = 8; i < 1536; i++) {
      c1[i] = i & 0xff;
    }

    const result = generateS0S1S2(c1);
    const s2 = result.slice(1537, 3073);

    // S2 should echo C1's first 4 bytes (timestamp)
    expect(s2.readUInt32BE(0)).toBe(0x12345678);

    // S2 data bytes (8+) should match C1 data bytes
    for (let i = 8; i < 1536; i++) {
      expect(s2[i]).toBe(i & 0xff);
    }
  });

  it('S1 has zero bytes at positions 4-7', () => {
    const c1 = Buffer.alloc(1536, 0xcd);
    const result = generateS0S1S2(c1);
    const s1 = result.slice(1, 1537);
    expect(s1.readUInt32BE(4)).toBe(0);
  });
});
