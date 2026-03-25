export interface PESPacketOptions {
  streamId: number;  // 0xE0 비디오, 0xC0 오디오
  payload: Buffer;
  pts: number;       // 90kHz 클럭
  dts?: number;      // 90kHz 클럭
}

/**
 * 33비트 PTS/DTS 타임스탬프를 5바이트로 인코딩한다.
 *
 * byte[0] = (marker << 4) | ((ts >> 29) & 0x0E) | 0x01
 * byte[1] = (ts >> 22) & 0xFF
 * byte[2] = ((ts >> 14) & 0xFE) | 0x01
 * byte[3] = (ts >> 7) & 0xFF
 * byte[4] = ((ts << 1) & 0xFE) | 0x01
 *
 * 바이트 0, 2, 4에 마커 비트 포함 (bit 0 = 1).
 */
function encodeTimestamp(buf: Buffer, offset: number, marker: number, ts: number): void {
  buf[offset + 0] = (marker << 4) | ((ts >> 29) & 0x0E) | 0x01;
  buf[offset + 1] = (ts >> 22) & 0xFF;
  buf[offset + 2] = ((ts >> 14) & 0xFE) | 0x01;
  buf[offset + 3] = (ts >> 7) & 0xFF;
  buf[offset + 4] = ((ts << 1) & 0xFE) | 0x01;
}

/**
 * PES (Packetized Elementary Stream) 패킷을 생성한다.
 *
 * 구조:
 *   [0-2]  시작 코드 접두사: 0x00 0x00 0x01
 *   [3]    stream_id
 *   [4-5]  PES_packet_length (빅엔디안; 0 = 무제한, 65535 초과 비디오 스트림용)
 *   [6]    PES 헤더 플래그 바이트 1: 0x84
 *   [7]    PES 헤더 플래그 바이트 2: 0x80 (PTS만) | 0xC0 (PTS+DTS)
 *   [8]    PES_header_data_length: 5 (PTS만) | 10 (PTS+DTS)
 *   [9-13] PTS (5바이트)
 *   [14-18] DTS (5바이트, 있는 경우)
 *   [...]  페이로드
 */
export function buildPESPacket(opts: PESPacketOptions): Buffer {
  const { streamId, payload, pts, dts } = opts;

  const hasDts = dts !== undefined;

  // 선택적 헤더: flags1(1) + flags2(1) + header_data_length(1) = 3바이트
  const optionalHeaderSize = 3;
  const ptsSize = 5;
  const dtsSize = hasDts ? 5 : 0;
  const headerDataLength = ptsSize + dtsSize;

  // packet_length 필드 이후 전체 바이트 수
  const bodySize = optionalHeaderSize + headerDataLength + payload.length;

  // PES_packet_length: 무제한 비디오는 0, 그 외 bodySize (16비트 이내여야 함)
  // 임계값: bodySize > 65535이고 streamId가 비디오인 경우
  const isVideo = streamId === 0xE0;
  const packetLength = (isVideo && bodySize > 65535) ? 0 : bodySize;

  // 전체 PES 패킷 크기: start_code(3) + stream_id(1) + packet_length(2) + body
  const totalSize = 3 + 1 + 2 + bodySize;
  const buf = Buffer.alloc(totalSize);

  let pos = 0;

  // 시작 코드 접두사
  buf[pos++] = 0x00;
  buf[pos++] = 0x00;
  buf[pos++] = 0x01;

  // stream_id
  buf[pos++] = streamId;

  // PES_packet_length (빅엔디안)
  buf[pos++] = (packetLength >> 8) & 0xFF;
  buf[pos++] = packetLength & 0xFF;

  // 선택적 PES 헤더
  // 바이트 6: flags1 = 0x84 (마커 비트 '10', 정렬 표시자 = 1)
  buf[pos++] = 0x84;

  // 바이트 7: flags2 = 0x80 (PTS만) 또는 0xC0 (PTS+DTS)
  buf[pos++] = hasDts ? 0xC0 : 0x80;

  // 바이트 8: PES_header_data_length
  buf[pos++] = headerDataLength;

  // PTS: 마커 = 0x02 (PTS만) 또는 0x03 (PTS+DTS)
  const ptsMarker = hasDts ? 0x03 : 0x02;
  encodeTimestamp(buf, pos, ptsMarker, pts);
  pos += ptsSize;

  // DTS: 마커 = 0x01
  if (hasDts) {
    encodeTimestamp(buf, pos, 0x01, dts!);
    pos += dtsSize;
  }

  // 페이로드
  payload.copy(buf, pos);

  return buf;
}
