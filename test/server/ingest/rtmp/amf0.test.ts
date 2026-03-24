import { describe, it, expect } from 'vitest';
import { decodeAMF0, decodeAMF0Multiple } from '../../../../src/server/ingest/rtmp/amf0.js';

describe('decodeAMF0', () => {
  it('decodes a number (type 0x00)', () => {
    const buf = Buffer.alloc(9);
    buf[0] = 0x00;
    buf.writeDoubleBE(42.5, 1);
    const result = decodeAMF0(buf);
    expect(result.value).toBe(42.5);
    expect(result.bytesRead).toBe(9);
  });

  it('decodes a boolean true (type 0x01)', () => {
    const buf = Buffer.from([0x01, 0x01]);
    const result = decodeAMF0(buf);
    expect(result.value).toBe(true);
    expect(result.bytesRead).toBe(2);
  });

  it('decodes a boolean false (type 0x01)', () => {
    const buf = Buffer.from([0x01, 0x00]);
    const result = decodeAMF0(buf);
    expect(result.value).toBe(false);
    expect(result.bytesRead).toBe(2);
  });

  it('decodes a string (type 0x02)', () => {
    const str = 'connect';
    const strBuf = Buffer.from(str, 'utf8');
    const buf = Buffer.alloc(3 + strBuf.length);
    buf[0] = 0x02;
    buf.writeUInt16BE(strBuf.length, 1);
    strBuf.copy(buf, 3);
    const result = decodeAMF0(buf);
    expect(result.value).toBe('connect');
    expect(result.bytesRead).toBe(3 + strBuf.length);
  });

  it('decodes null (type 0x05)', () => {
    const buf = Buffer.from([0x05]);
    const result = decodeAMF0(buf);
    expect(result.value).toBeNull();
    expect(result.bytesRead).toBe(1);
  });

  it('returns undefined for unknown type', () => {
    const buf = Buffer.from([0xff]);
    const result = decodeAMF0(buf);
    expect(result.value).toBeUndefined();
    expect(result.bytesRead).toBe(1);
  });

  it('decodes an object (type 0x03)', () => {
    // Build: { app: "live" }
    const key = 'app';
    const val = 'live';
    const keyBuf = Buffer.from(key, 'utf8');
    const valBuf = Buffer.from(val, 'utf8');

    // type(1) + keyLen(2) + key + valueType(1) + valLen(2) + val + endMarker(3)
    const size = 1 + 2 + keyBuf.length + 1 + 2 + valBuf.length + 3;
    const buf = Buffer.alloc(size);
    let pos = 0;
    buf[pos++] = 0x03; // object type
    buf.writeUInt16BE(keyBuf.length, pos); pos += 2;
    keyBuf.copy(buf, pos); pos += keyBuf.length;
    buf[pos++] = 0x02; // string value
    buf.writeUInt16BE(valBuf.length, pos); pos += 2;
    valBuf.copy(buf, pos); pos += valBuf.length;
    // end marker
    buf[pos++] = 0x00;
    buf[pos++] = 0x00;
    buf[pos++] = 0x09;

    const result = decodeAMF0(buf);
    expect(result.value).toEqual({ app: 'live' });
    expect(result.bytesRead).toBe(size);
  });
});

describe('decodeAMF0Multiple', () => {
  it('decodes multiple values from a buffer', () => {
    // "connect" (string) + 1.0 (number)
    const str = 'connect';
    const strBuf = Buffer.from(str, 'utf8');
    const part1 = Buffer.alloc(3 + strBuf.length);
    part1[0] = 0x02;
    part1.writeUInt16BE(strBuf.length, 1);
    strBuf.copy(part1, 3);

    const part2 = Buffer.alloc(9);
    part2[0] = 0x00;
    part2.writeDoubleBE(1.0, 1);

    const buf = Buffer.concat([part1, part2]);
    const results = decodeAMF0Multiple(buf);
    expect(results).toHaveLength(2);
    expect(results[0]).toBe('connect');
    expect(results[1]).toBe(1.0);
  });
});
