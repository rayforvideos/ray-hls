/**
 * Low-level helpers for constructing ISO BMFF (MP4) boxes.
 * All operations use Uint8Array/DataView for browser compatibility.
 */

/** Concatenate multiple Uint8Arrays into one. */
export function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** Encode a 32-bit unsigned integer as big-endian 4 bytes. */
export function uint32(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, value >>> 0, false);
  return buf;
}

/** Encode a 16-bit unsigned integer as big-endian 2 bytes. */
export function uint16(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  const view = new DataView(buf.buffer);
  view.setUint16(0, value & 0xffff, false);
  return buf;
}

/** Encode an 8-bit unsigned integer as 1 byte. */
export function uint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

/**
 * Create an MP4 box: 4-byte size (big-endian) + 4-byte ASCII type + payloads.
 */
export function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  let payloadSize = 0;
  for (const p of payloads) {
    payloadSize += p.length;
  }
  const size = 8 + payloadSize; // 4 (size) + 4 (type) + payload
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, size, false);
  header[4] = type.charCodeAt(0);
  header[5] = type.charCodeAt(1);
  header[6] = type.charCodeAt(2);
  header[7] = type.charCodeAt(3);
  return concat(header, ...payloads);
}

/**
 * Create a full box: box with version (1 byte) + flags (3 bytes) prepended to payload.
 */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payloads: Uint8Array[]
): Uint8Array {
  const versionFlags = new Uint8Array(4);
  versionFlags[0] = version & 0xff;
  versionFlags[1] = (flags >>> 16) & 0xff;
  versionFlags[2] = (flags >>> 8) & 0xff;
  versionFlags[3] = flags & 0xff;
  return box(type, versionFlags, ...payloads);
}
