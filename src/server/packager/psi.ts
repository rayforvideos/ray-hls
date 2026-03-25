import { STREAM_TYPE_H264, STREAM_TYPE_AAC } from '../../shared/types.js';

/**
 * MPEG-2 생성 다항식 0x04C11DB7을 사용하는 CRC32 룩업 테이블.
 * 모듈 로드 시 한 번만 생성된다.
 */
const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/**
 * 제공된 버퍼에 대해 CRC32/MPEG-2 체크섬을 계산한다.
 */
function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[((crc >> 24) ^ data[i]) & 0xFF] ^ (crc << 8)) >>> 0;
  }
  return crc;
}

/**
 * PAT (프로그램 연관 테이블) 섹션을 생성한다.
 *
 * 구조 (총 16바이트):
 *   [0]     table_id = 0x00
 *   [1..2]  section_syntax_indicator(1) | '0'(1) | 예약(2) | section_length(12) = 13
 *   [3..4]  transport_stream_id = 0x0001
 *   [5]     예약(2) | version_number(5)=0 | current_next_indicator(1)=1 → 0xC1
 *   [6]     section_number = 0x00
 *   [7]     last_section_number = 0x00
 *   [8..9]  program_number = 0x0001
 *   [10..11] 예약(3) | PMT_PID(13)
 *   [12..15] CRC32
 */
export function buildPAT(pmtPid: number): Buffer {
  // 합계: 고정 헤더 3바이트 + section_length 13바이트 = 16바이트
  const buf = Buffer.alloc(16, 0x00);
  let pos = 0;

  // table_id
  buf[pos++] = 0x00;

  // section_syntax_indicator=1, '0'=1, 예약=11, section_length=13
  const sectionLength = 13;
  buf[pos++] = 0xB0 | (sectionLength >> 8);
  buf[pos++] = sectionLength & 0xFF;

  // transport_stream_id = 0x0001
  buf[pos++] = 0x00;
  buf[pos++] = 0x01;

  // 예약(11) | version_number(00000) | current_next_indicator(1) = 0xC1
  buf[pos++] = 0xC1;

  // section_number
  buf[pos++] = 0x00;

  // last_section_number
  buf[pos++] = 0x00;

  // program_number = 1
  buf[pos++] = 0x00;
  buf[pos++] = 0x01;

  // 예약(111) | PMT_PID(13비트)
  buf[pos++] = 0xE0 | ((pmtPid >> 8) & 0x1F);
  buf[pos++] = pmtPid & 0xFF;

  // 앞선 모든 바이트에 대한 CRC32
  const checksum = crc32(buf.subarray(0, pos));
  buf[pos++] = (checksum >>> 24) & 0xFF;
  buf[pos++] = (checksum >>> 16) & 0xFF;
  buf[pos++] = (checksum >>> 8) & 0xFF;
  buf[pos++] = checksum & 0xFF;

  return buf;
}

/**
 * PMT (프로그램 맵 테이블) 섹션을 생성한다.
 *
 * section_length = [3]부터 CRC 끝까지의 바이트 수:
 *   program_number(2) + version(1) + sec_num(1) + last_sec_num(1)
 *   + pcr_pid(2) + program_info_length(2) + 스트림 항목 2개(5×2) + CRC(4) = 23
 * 총 버퍼 = 3 (table_id + section_length 필드) + 23 = 26바이트
 */
export function buildPMT(videoPid: number, audioPid: number): Buffer {
  const buf = Buffer.alloc(26, 0x00);
  let pos = 0;

  // table_id
  buf[pos++] = 0x02;

  // section_syntax_indicator=1, '0'=1, 예약=11, section_length=23
  // 고정 필드(9) + 스트림 항목 2개(10) + CRC(4) = 23
  const sectionLength = 23;
  buf[pos++] = 0xB0 | (sectionLength >> 8);
  buf[pos++] = sectionLength & 0xFF;

  // program_number = 1
  buf[pos++] = 0x00;
  buf[pos++] = 0x01;

  // 예약(11) | version_number(00000) | current_next_indicator(1) = 0xC1
  buf[pos++] = 0xC1;

  // section_number
  buf[pos++] = 0x00;

  // last_section_number
  buf[pos++] = 0x00;

  // 예약(111) | PCR_PID(13비트) — 비디오 PID를 PCR PID로 사용
  buf[pos++] = 0xE0 | ((videoPid >> 8) & 0x1F);
  buf[pos++] = videoPid & 0xFF;

  // 예약(1111) | program_info_length(12) = 0 → 0xF0, 0x00
  buf[pos++] = 0xF0;
  buf[pos++] = 0x00;

  // 비디오 스트림 항목 (5바이트)
  buf[pos++] = STREAM_TYPE_H264; // 0x1B
  buf[pos++] = 0xE0 | ((videoPid >> 8) & 0x1F); // 예약(111) | PID 상위 비트
  buf[pos++] = videoPid & 0xFF;
  buf[pos++] = 0xF0; // 예약(1111) | ES_info_length 상위 = 0
  buf[pos++] = 0x00; // ES_info_length 하위 = 0

  // 오디오 스트림 항목 (5바이트)
  buf[pos++] = STREAM_TYPE_AAC; // 0x0F
  buf[pos++] = 0xE0 | ((audioPid >> 8) & 0x1F); // 예약(111) | PID 상위 비트
  buf[pos++] = audioPid & 0xFF;
  buf[pos++] = 0xF0; // 예약(1111) | ES_info_length 상위 = 0
  buf[pos++] = 0x00; // ES_info_length 하위 = 0

  // 앞선 모든 바이트에 대한 CRC32
  const checksum = crc32(buf.subarray(0, pos));
  buf[pos++] = (checksum >>> 24) & 0xFF;
  buf[pos++] = (checksum >>> 16) & 0xFF;
  buf[pos++] = (checksum >>> 8) & 0xFF;
  buf[pos++] = checksum & 0xFF;

  return buf.subarray(0, pos);
}
