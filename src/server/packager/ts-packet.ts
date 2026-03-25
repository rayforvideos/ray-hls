import { TS_PACKET_SIZE } from '../../shared/types.js';

export interface TSPacketOptions {
  pid: number;
  payload: Buffer;
  payloadUnitStart: boolean;
  continuityCounter: number;
  pcr?: number; // 90kHz 클럭 값
}

// PCR 필드는 항상 6바이트 (33비트 기저 + 6비트 예약 + 9비트 확장)
const PCR_FIELD_SIZE = 6;
// 적응 필드 플래그 바이트 크기
const AF_FLAGS_SIZE = 1;
// 적응 필드 길이 바이트 크기
const AF_LENGTH_BYTE_SIZE = 1;
// TS 헤더 크기
const TS_HEADER_SIZE = 4;
// 적응 필드가 없는 TS 패킷의 최대 페이로드 크기
const MAX_PAYLOAD_SIZE = TS_PACKET_SIZE - TS_HEADER_SIZE; // 184

/**
 * 90kHz PCR 값을 적응 필드 PCR 데이터 6바이트로 인코딩한다.
 * 레이아웃: 33비트 기저 | 6비트 예약(모두 1) | 9비트 확장(0)
 *
 *  바이트 0: base[32:25]
 *  바이트 1: base[24:17]
 *  바이트 2: base[16:9]
 *  바이트 3: base[8:1]
 *  바이트 4: base[0] | 예약(111111) | ext[8]
 *  바이트 5: ext[7:0]
 */
function encodePCR(buf: Buffer, offset: number, pcr: number): void {
  const base = BigInt(pcr) & 0x1_ffff_ffffn; // 33비트
  const ext = 0n; // 항상 0

  buf[offset + 0] = Number((base >> 25n) & 0xFFn);
  buf[offset + 1] = Number((base >> 17n) & 0xFFn);
  buf[offset + 2] = Number((base >> 9n) & 0xFFn);
  buf[offset + 3] = Number((base >> 1n) & 0xFFn);
  // bit7: base[0], bits6:1: 예약(111111), bit0: ext[8]
  buf[offset + 4] = Number(((base & 0x01n) << 7n) | (0x3Fn << 1n) | ((ext >> 8n) & 0x01n));
  buf[offset + 5] = Number(ext & 0xFFn);
}

export function buildTSPacket(opts: TSPacketOptions): Buffer {
  const { pid, payload, payloadUnitStart, continuityCounter, pcr } = opts;

  const hasPCR = pcr !== undefined;
  // PCR에 필요한 적응 필드 최소 데이터 크기 (플래그 바이트 + PCR 바이트)
  const minAFDataSize = hasPCR ? AF_FLAGS_SIZE + PCR_FIELD_SIZE : AF_FLAGS_SIZE;

  // 적응 필드 필요 여부 판단:
  // - PCR이 존재하거나
  // - 페이로드가 184바이트보다 짧은 경우 (스터핑 필요)
  const needsAF = hasPCR || payload.length < MAX_PAYLOAD_SIZE;

  let adaptationFieldControl: number;
  let afLength: number; // adaptation_field_length 바이트에 기록될 값

  if (!needsAF) {
    // 페이로드만 존재
    adaptationFieldControl = 0x01;
    afLength = 0; // 사용되지 않음
  } else if (payload.length === 0) {
    // 적응 필드만 존재 (페이로드 없음)
    adaptationFieldControl = 0x02;
    // afLength가 나머지 공간 전체를 채움: 188 - 4(헤더) - 1(afLen 바이트) = 183
    afLength = MAX_PAYLOAD_SIZE - AF_LENGTH_BYTE_SIZE; // 183
  } else {
    // 적응 필드 + 페이로드
    adaptationFieldControl = 0x03;
    // afLength = 188 - 4(헤더) - 1(afLen 바이트) - payload.length
    afLength = MAX_PAYLOAD_SIZE - AF_LENGTH_BYTE_SIZE - payload.length;
  }

  // 적응 필드가 필요하지만 계산된 afLength가 최소 AF 데이터 크기보다 작으면
  // 문제가 있다. 실제로는 호출자가 이를 방지해야 하지만 안전을 위한 가드.
  // afLength == 0이면 적응 필드가 존재하되 비어있음 (플래그 바이트 없음).
  // ISO 13818-1에 따르면 afLength=0은 유효함 (스터핑 바이트 1개 = afLen 바이트 자체).

  const packet = Buffer.alloc(TS_PACKET_SIZE, 0x00);
  let pos = 0;

  // 바이트 0: 동기 바이트
  packet[pos++] = 0x47;

  // 바이트 1-2: TEI(0) | PUSI | 우선순위(0) | PID[12:0]
  const pusiBit = payloadUnitStart ? 0x40 : 0x00;
  packet[pos++] = pusiBit | ((pid >> 8) & 0x1F);
  packet[pos++] = pid & 0xFF;

  // 바이트 3: 스크램블링(00) | AFC(2비트) | CC(4비트)
  packet[pos++] = ((adaptationFieldControl & 0x03) << 4) | (continuityCounter & 0x0F);

  // 적응 필드
  if (needsAF) {
    packet[pos++] = afLength; // adaptation_field_length

    if (afLength > 0) {
      // 플래그 바이트
      const pcrFlag = hasPCR ? 0x10 : 0x00;
      packet[pos++] = pcrFlag; // 불연속=0, 랜덤접근=0, 우선순위=0, PCR_flag, 나머지=0

      if (hasPCR) {
        encodePCR(packet, pos, pcr!);
        pos += PCR_FIELD_SIZE;
      }

      // 스터핑: 남은 적응 필드 바이트를 0xFF로 채움
      const stuffingEnd = TS_HEADER_SIZE + AF_LENGTH_BYTE_SIZE + afLength;
      while (pos < stuffingEnd) {
        packet[pos++] = 0xFF;
      }
    }
  }

  // 페이로드
  if (payload.length > 0) {
    payload.copy(packet, pos);
  }

  return packet;
}
