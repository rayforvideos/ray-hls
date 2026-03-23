import { describe, it, expect } from 'vitest';
import { box, fullBox, uint32, uint16, uint8, concat } from '../../../src/client/remuxer/mp4-box.js';

describe('mp4-box', () => {
  describe('uint8', () => {
    it('encodes a single byte', () => {
      const result = uint8(0xab);
      expect(result).toEqual(new Uint8Array([0xab]));
    });
  });

  describe('uint16', () => {
    it('encodes big-endian 16-bit', () => {
      const result = uint16(0x1234);
      expect(result).toEqual(new Uint8Array([0x12, 0x34]));
    });
  });

  describe('uint32', () => {
    it('encodes big-endian 32-bit', () => {
      const result = uint32(0x12345678);
      expect(result).toEqual(new Uint8Array([0x12, 0x34, 0x56, 0x78]));
    });

    it('handles zero', () => {
      const result = uint32(0);
      expect(result).toEqual(new Uint8Array([0, 0, 0, 0]));
    });
  });

  describe('concat', () => {
    it('concatenates multiple arrays', () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([3, 4, 5]);
      const result = concat(a, b);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it('handles empty arrays', () => {
      const result = concat(new Uint8Array(0), new Uint8Array([1]));
      expect(result).toEqual(new Uint8Array([1]));
    });
  });

  describe('box', () => {
    it('creates a box with correct size', () => {
      const payload = new Uint8Array([0x01, 0x02, 0x03]);
      const result = box('test', payload);
      // size = 8 (header) + 3 (payload) = 11
      expect(result.length).toBe(11);
      const view = new DataView(result.buffer);
      expect(view.getUint32(0, false)).toBe(11);
    });

    it('encodes the type as ASCII', () => {
      const result = box('ftyp');
      expect(result[4]).toBe(0x66); // 'f'
      expect(result[5]).toBe(0x74); // 't'
      expect(result[6]).toBe(0x79); // 'y'
      expect(result[7]).toBe(0x70); // 'p'
    });

    it('creates an empty box with size 8', () => {
      const result = box('test');
      expect(result.length).toBe(8);
      const view = new DataView(result.buffer);
      expect(view.getUint32(0, false)).toBe(8);
    });

    it('concatenates multiple payloads', () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([3, 4]);
      const result = box('test', a, b);
      expect(result.length).toBe(12); // 8 + 4
      expect(result[8]).toBe(1);
      expect(result[9]).toBe(2);
      expect(result[10]).toBe(3);
      expect(result[11]).toBe(4);
    });
  });

  describe('fullBox', () => {
    it('includes version and flags', () => {
      const result = fullBox('mvhd', 1, 0x000003);
      // 8 (box header) + 4 (version+flags) = 12
      expect(result.length).toBe(12);
      expect(result[8]).toBe(1);   // version
      expect(result[9]).toBe(0);   // flags byte 1
      expect(result[10]).toBe(0);  // flags byte 2
      expect(result[11]).toBe(3);  // flags byte 3
    });

    it('calculates size including version/flags + payload', () => {
      const payload = new Uint8Array(10);
      const result = fullBox('tkhd', 0, 0x000003, payload);
      // 8 + 4 + 10 = 22
      expect(result.length).toBe(22);
      const view = new DataView(result.buffer);
      expect(view.getUint32(0, false)).toBe(22);
    });
  });

  describe('nesting boxes', () => {
    it('supports nested boxes with correct sizes', () => {
      const inner = box('inr1', new Uint8Array([0xff]));
      const outer = box('outr', inner);
      // inner: 8 + 1 = 9
      // outer: 8 + 9 = 17
      expect(inner.length).toBe(9);
      expect(outer.length).toBe(17);
      const outerView = new DataView(outer.buffer);
      expect(outerView.getUint32(0, false)).toBe(17);
      // inner box starts at offset 8 of outer
      const innerView = new DataView(outer.buffer, 8);
      expect(innerView.getUint32(0, false)).toBe(9);
    });
  });
});
