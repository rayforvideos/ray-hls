import { STREAM_TYPE_H264, STREAM_TYPE_AAC } from '../../shared/types.js';

/**
 * Compute CRC32/MPEG-2 checksum over the provided buffer.
 * Uses the MPEG-2 generator polynomial 0x04C11DB7.
 */
function crc32(data: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
    }
    table[i] = crc >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (table[((crc >> 24) ^ data[i]) & 0xFF] ^ (crc << 8)) >>> 0;
  }
  return crc;
}

/**
 * Build a PAT (Program Association Table) section.
 *
 * Structure (16 bytes total):
 *   [0]     table_id = 0x00
 *   [1..2]  section_syntax_indicator(1) | '0'(1) | reserved(2) | section_length(12) = 13
 *   [3..4]  transport_stream_id = 0x0001
 *   [5]     reserved(2) | version_number(5)=0 | current_next_indicator(1)=1 → 0xC1
 *   [6]     section_number = 0x00
 *   [7]     last_section_number = 0x00
 *   [8..9]  program_number = 0x0001
 *   [10..11] reserved(3) | PMT_PID(13)
 *   [12..15] CRC32
 */
export function buildPAT(pmtPid: number): Buffer {
  // Total: 3 bytes fixed header + 13 bytes (section_length) = 16 bytes
  const buf = Buffer.alloc(16, 0x00);
  let pos = 0;

  // table_id
  buf[pos++] = 0x00;

  // section_syntax_indicator=1, '0'=1, reserved=11, section_length=13
  // byte: 1011 xxxx xxxx xxxx = 0xB0 | (13 >> 8), 13 & 0xFF
  const sectionLength = 13;
  buf[pos++] = 0xB0 | (sectionLength >> 8);
  buf[pos++] = sectionLength & 0xFF;

  // transport_stream_id = 0x0001
  buf[pos++] = 0x00;
  buf[pos++] = 0x01;

  // reserved(11) | version_number(00000) | current_next_indicator(1)
  // = 1100 0001 = 0xC1
  buf[pos++] = 0xC1;

  // section_number
  buf[pos++] = 0x00;

  // last_section_number
  buf[pos++] = 0x00;

  // program_number = 1
  buf[pos++] = 0x00;
  buf[pos++] = 0x01;

  // reserved(111) | PMT_PID(13 bits)
  buf[pos++] = 0xE0 | ((pmtPid >> 8) & 0x1F);
  buf[pos++] = pmtPid & 0xFF;

  // CRC32 over all preceding bytes
  const checksum = crc32(buf.subarray(0, pos));
  buf[pos++] = (checksum >>> 24) & 0xFF;
  buf[pos++] = (checksum >>> 16) & 0xFF;
  buf[pos++] = (checksum >>> 8) & 0xFF;
  buf[pos++] = checksum & 0xFF;

  return buf;
}

/**
 * Build a PMT (Program Map Table) section.
 *
 * Structure (22 bytes total):
 *   [0]     table_id = 0x02
 *   [1..2]  section_syntax_indicator(1) | '0'(1) | reserved(2) | section_length(12) = 19
 *   [3..4]  program_number = 0x0001
 *   [5]     reserved(2) | version_number(5)=0 | current_next_indicator(1)=1 → 0xC1
 *   [6]     section_number = 0x00
 *   [7]     last_section_number = 0x00
 *   [8..9]  reserved(3) | PCR_PID(13) — set to videoPid
 *   [10..11] reserved(4) | program_info_length(12) = 0 → 0xF0 | 0x00
 *   [12..16] video stream entry (5 bytes):
 *             stream_type(1)=0x1B | reserved(3)+PID(13) | reserved(4)+ES_info_length(12)=0
 *   [17..21] audio stream entry (5 bytes):
 *             stream_type(1)=0x0F | reserved(3)+PID(13) | reserved(4)+ES_info_length(12)=0
 *   [22..25] (wait — section_length counts from byte 3 onward through CRC)
 *
 * section_length = bytes from [3] through end including CRC32:
 *   program_number(2) + version(1) + sec_num(1) + last_sec_num(1)
 *   + pcr_pid(2) + program_info_length(2) + 2×stream_entry(5) + CRC(4) = 19
 * Total buffer = 3 (table_id + section_length field) + 19 = 22 bytes
 */
export function buildPMT(videoPid: number, audioPid: number): Buffer {
  const buf = Buffer.alloc(26, 0x00);
  let pos = 0;

  // table_id
  buf[pos++] = 0x02;

  // section_syntax_indicator=1, '0'=1, reserved=11, section_length=19
  const sectionLength = 19 + 4; // fixed fields(7) + 2 stream entries(10) + CRC(4) = ... let's compute
  // Fixed: program_number(2) + version(1) + sec(1) + last_sec(1) + pcr_pid(2) + prog_info_len(2) = 9
  // Stream entries: 2 × 5 = 10
  // CRC: 4
  // Total section_length = 9 + 10 + 4 = 23
  const sl = 23;
  buf[pos++] = 0xB0 | (sl >> 8);
  buf[pos++] = sl & 0xFF;

  // program_number = 1
  buf[pos++] = 0x00;
  buf[pos++] = 0x01;

  // reserved(11) | version_number(00000) | current_next_indicator(1) = 0xC1
  buf[pos++] = 0xC1;

  // section_number
  buf[pos++] = 0x00;

  // last_section_number
  buf[pos++] = 0x00;

  // reserved(111) | PCR_PID(13 bits) — use video PID as PCR PID
  buf[pos++] = 0xE0 | ((videoPid >> 8) & 0x1F);
  buf[pos++] = videoPid & 0xFF;

  // reserved(1111) | program_info_length(12) = 0 → 0xF0, 0x00
  buf[pos++] = 0xF0;
  buf[pos++] = 0x00;

  // Video stream entry (5 bytes)
  buf[pos++] = STREAM_TYPE_H264; // 0x1B
  buf[pos++] = 0xE0 | ((videoPid >> 8) & 0x1F); // reserved(111) | PID high bits
  buf[pos++] = videoPid & 0xFF;
  buf[pos++] = 0xF0; // reserved(1111) | ES_info_length high = 0
  buf[pos++] = 0x00; // ES_info_length low = 0

  // Audio stream entry (5 bytes)
  buf[pos++] = STREAM_TYPE_AAC; // 0x0F
  buf[pos++] = 0xE0 | ((audioPid >> 8) & 0x1F); // reserved(111) | PID high bits
  buf[pos++] = audioPid & 0xFF;
  buf[pos++] = 0xF0; // reserved(1111) | ES_info_length high = 0
  buf[pos++] = 0x00; // ES_info_length low = 0

  // CRC32 over all preceding bytes
  const checksum = crc32(buf.subarray(0, pos));
  buf[pos++] = (checksum >>> 24) & 0xFF;
  buf[pos++] = (checksum >>> 16) & 0xFF;
  buf[pos++] = (checksum >>> 8) & 0xFF;
  buf[pos++] = checksum & 0xFF;

  return buf.subarray(0, pos);
}
