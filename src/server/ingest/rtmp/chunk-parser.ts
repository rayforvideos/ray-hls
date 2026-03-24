export const CHUNK_HEADER_TYPE = {
  TYPE_0: 0,
  TYPE_1: 1,
  TYPE_2: 2,
  TYPE_3: 3,
} as const;

export interface ChunkHeader {
  fmt: number;
  csid: number;
  timestamp?: number;
  timestampDelta?: number;
  messageLength?: number;
  messageTypeId?: number;
  messageStreamId?: number;
  headerSize: number;
}

export function parseChunkHeader(buf: Buffer): ChunkHeader {
  let pos = 0;

  const firstByte = buf[pos++];
  const fmt = (firstByte >> 6) & 0x03;
  let csid = firstByte & 0x3f;

  // Handle extended csid
  if (csid === 0) {
    // next byte + 64
    csid = buf[pos++] + 64;
  } else if (csid === 1) {
    // next 2 bytes: low byte + high byte * 256 + 64
    const low = buf[pos++];
    const high = buf[pos++];
    csid = high * 256 + low + 64;
  }

  const header: ChunkHeader = { fmt, csid, headerSize: 0 };

  if (fmt === 0) {
    // Type 0: 12 bytes total (basic header + 11 bytes message header)
    header.timestamp = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
    header.messageLength = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
    header.messageTypeId = buf[pos++];
    header.messageStreamId = buf.readUInt32LE(pos);
    pos += 4;
  } else if (fmt === 1) {
    // Type 1: 8 bytes total (basic header + 7 bytes message header)
    header.timestampDelta = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
    header.messageLength = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
    header.messageTypeId = buf[pos++];
  } else if (fmt === 2) {
    // Type 2: 4 bytes total (basic header + 3 bytes)
    header.timestampDelta = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
  }
  // Type 3: basic header only (1 byte)

  header.headerSize = pos;
  return header;
}

export const MSG_TYPE_AUDIO = 0x08;
export const MSG_TYPE_VIDEO = 0x09;
export const MSG_TYPE_COMMAND_AMF0 = 0x14;
export const MSG_TYPE_DATA_AMF0 = 0x12;
