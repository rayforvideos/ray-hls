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

  // 확장 csid 처리
  if (csid === 0) {
    // 다음 1바이트 + 64
    csid = buf[pos++] + 64;
  } else if (csid === 1) {
    // 다음 2바이트: low + high * 256 + 64
    const low = buf[pos++];
    const high = buf[pos++];
    csid = high * 256 + low + 64;
  }

  const header: ChunkHeader = { fmt, csid, headerSize: 0 };

  if (fmt === 0) {
    // 타입 0: 총 12바이트 (기본 헤더 + 메시지 헤더 11바이트)
    header.timestamp = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
    header.messageLength = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
    header.messageTypeId = buf[pos++];
    header.messageStreamId = buf.readUInt32LE(pos);
    pos += 4;
  } else if (fmt === 1) {
    // 타입 1: 총 8바이트 (기본 헤더 + 메시지 헤더 7바이트)
    header.timestampDelta = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
    header.messageLength = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
    header.messageTypeId = buf[pos++];
  } else if (fmt === 2) {
    // 타입 2: 총 4바이트 (기본 헤더 + 3바이트)
    header.timestampDelta = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    pos += 3;
  }
  // 타입 3: 기본 헤더만 (1바이트)

  header.headerSize = pos;
  return header;
}

export const MSG_TYPE_AUDIO = 0x08;
export const MSG_TYPE_VIDEO = 0x09;
export const MSG_TYPE_COMMAND_AMF0 = 0x14;
export const MSG_TYPE_DATA_AMF0 = 0x12;
