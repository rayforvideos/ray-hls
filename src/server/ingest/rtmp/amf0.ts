export interface AMF0Result {
  value: unknown;
  bytesRead: number;
}

export function decodeAMF0(buf: Buffer, offset: number = 0): AMF0Result {
  const type = buf[offset];

  switch (type) {
    case 0x00: {
      // Number: 8-byte double BE
      const value = buf.readDoubleBE(offset + 1);
      return { value, bytesRead: 9 };
    }
    case 0x01: {
      // Boolean: 1 byte
      const value = buf[offset + 1] !== 0;
      return { value, bytesRead: 2 };
    }
    case 0x02: {
      // String: 2-byte length + utf8
      const len = buf.readUInt16BE(offset + 1);
      const value = buf.toString('utf8', offset + 3, offset + 3 + len);
      return { value, bytesRead: 3 + len };
    }
    case 0x03: {
      // Object: key-value pairs until 0x000009 end marker
      const obj: Record<string, unknown> = {};
      let pos = offset + 1;
      while (pos < buf.length) {
        // Check for end marker: 0x00 0x00 0x09
        if (buf[pos] === 0x00 && buf[pos + 1] === 0x00 && buf[pos + 2] === 0x09) {
          pos += 3;
          break;
        }
        // Read key (2-byte length + utf8)
        const keyLen = buf.readUInt16BE(pos);
        pos += 2;
        const key = buf.toString('utf8', pos, pos + keyLen);
        pos += keyLen;
        // Read value
        const result = decodeAMF0(buf, pos);
        obj[key] = result.value;
        pos += result.bytesRead;
      }
      return { value: obj, bytesRead: pos - offset };
    }
    case 0x05: {
      // Null
      return { value: null, bytesRead: 1 };
    }
    default: {
      return { value: undefined, bytesRead: 1 };
    }
  }
}

export function decodeAMF0Multiple(buf: Buffer): unknown[] {
  const results: unknown[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const result = decodeAMF0(buf, offset);
    results.push(result.value);
    offset += result.bytesRead;
  }
  return results;
}
