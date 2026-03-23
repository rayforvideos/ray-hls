export interface PESPacketOptions {
  streamId: number;  // 0xE0 video, 0xC0 audio
  payload: Buffer;
  pts: number;       // 90kHz clock
  dts?: number;      // 90kHz clock
}

/**
 * Encode a 33-bit PTS/DTS timestamp into 5 bytes.
 *
 * byte[0] = (marker << 4) | ((ts >> 29) & 0x0E) | 0x01
 * byte[1] = (ts >> 22) & 0xFF
 * byte[2] = ((ts >> 14) & 0xFE) | 0x01
 * byte[3] = (ts >> 7) & 0xFF
 * byte[4] = ((ts << 1) & 0xFE) | 0x01
 *
 * Bytes 0, 2, and 4 carry marker bits (bit 0 = 1).
 */
function encodeTimestamp(buf: Buffer, offset: number, marker: number, ts: number): void {
  buf[offset + 0] = (marker << 4) | ((ts >> 29) & 0x0E) | 0x01;
  buf[offset + 1] = (ts >> 22) & 0xFF;
  buf[offset + 2] = ((ts >> 14) & 0xFE) | 0x01;
  buf[offset + 3] = (ts >> 7) & 0xFF;
  buf[offset + 4] = ((ts << 1) & 0xFE) | 0x01;
}

/**
 * Build a PES (Packetized Elementary Stream) packet.
 *
 * Structure:
 *   [0-2]  Start code prefix: 0x00 0x00 0x01
 *   [3]    stream_id
 *   [4-5]  PES_packet_length (big-endian; 0 = unbounded, for video streams > 65535)
 *   [6]    Optional PES header flags byte 1: 0x84
 *   [7]    Optional PES header flags byte 2: 0x80 (PTS only) | 0xC0 (PTS+DTS)
 *   [8]    PES_header_data_length: 5 (PTS only) | 10 (PTS+DTS)
 *   [9-13] PTS (5 bytes)
 *   [14-18] DTS (5 bytes, if present)
 *   [...]  payload
 */
export function buildPESPacket(opts: PESPacketOptions): Buffer {
  const { streamId, payload, pts, dts } = opts;

  const hasDts = dts !== undefined;

  // Optional header: flags1(1) + flags2(1) + header_data_length(1) = 3 bytes
  const optionalHeaderSize = 3;
  const ptsSize = 5;
  const dtsSize = hasDts ? 5 : 0;
  const headerDataLength = ptsSize + dtsSize;

  // Total bytes after packet_length field
  const bodySize = optionalHeaderSize + headerDataLength + payload.length;

  // PES_packet_length: 0 for unbounded video, else bodySize (must fit in 16 bits)
  // The threshold is: bodySize > 65535 and streamId is video
  const isVideo = streamId === 0xE0;
  const packetLength = (isVideo && bodySize > 65535) ? 0 : bodySize;

  // Total PES packet size: start_code(3) + stream_id(1) + packet_length(2) + body
  const totalSize = 3 + 1 + 2 + bodySize;
  const buf = Buffer.alloc(totalSize);

  let pos = 0;

  // Start code prefix
  buf[pos++] = 0x00;
  buf[pos++] = 0x00;
  buf[pos++] = 0x01;

  // stream_id
  buf[pos++] = streamId;

  // PES_packet_length (big-endian)
  buf[pos++] = (packetLength >> 8) & 0xFF;
  buf[pos++] = packetLength & 0xFF;

  // Optional PES header
  // Byte 6: flags1 = 0x84 (marker bits '10', alignment_indicator = 1)
  buf[pos++] = 0x84;

  // Byte 7: flags2 = 0x80 (PTS only) or 0xC0 (PTS+DTS)
  buf[pos++] = hasDts ? 0xC0 : 0x80;

  // Byte 8: PES_header_data_length
  buf[pos++] = headerDataLength;

  // PTS: marker = 0x02 (PTS only) or 0x03 (PTS+DTS)
  const ptsMarker = hasDts ? 0x03 : 0x02;
  encodeTimestamp(buf, pos, ptsMarker, pts);
  pos += ptsSize;

  // DTS: marker = 0x01
  if (hasDts) {
    encodeTimestamp(buf, pos, 0x01, dts!);
    pos += dtsSize;
  }

  // Payload
  payload.copy(buf, pos);

  return buf;
}
