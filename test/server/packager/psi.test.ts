import { describe, it, expect } from 'vitest';
import { buildPAT, buildPMT } from '../../../src/server/packager/psi.js';
import { VIDEO_PID, AUDIO_PID, PMT_PID, STREAM_TYPE_H264, STREAM_TYPE_AAC } from '../../../src/shared/types.js';

// CRC32/MPEG-2 reference implementation for test verification
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

describe('buildPAT', () => {
  it('starts with table_id 0x00', () => {
    const pat = buildPAT(PMT_PID);
    expect(pat[0]).toBe(0x00);
  });

  it('sets section_syntax_indicator (bit 7 of byte 1)', () => {
    const pat = buildPAT(PMT_PID);
    expect((pat[1] >> 7) & 0x01).toBe(1);
  });

  it('contains program number 1 mapped to the given PMT PID', () => {
    const pat = buildPAT(PMT_PID);
    // PAT layout:
    //   [0]     table_id
    //   [1..2]  section_syntax_indicator | reserved | section_length
    //   [3..4]  transport_stream_id
    //   [5]     version/current_next
    //   [6]     section_number
    //   [7]     last_section_number
    //   [8..9]  program_number (2 bytes)
    //   [10..11] reserved(3) | PMT_PID(13)
    //   [12..15] CRC32
    const programNumber = (pat[8] << 8) | pat[9];
    expect(programNumber).toBe(1);

    const pmtPid = ((pat[10] & 0x1F) << 8) | pat[11];
    expect(pmtPid).toBe(PMT_PID);
  });

  it('uses a different PMT PID when specified', () => {
    const customPmtPid = 0x0200;
    const pat = buildPAT(customPmtPid);
    const pmtPid = ((pat[10] & 0x1F) << 8) | pat[11];
    expect(pmtPid).toBe(customPmtPid);
  });

  it('ends with a valid CRC32', () => {
    const pat = buildPAT(PMT_PID);
    // CRC covers all bytes except the last 4
    const dataForCrc = pat.subarray(0, pat.length - 4);
    const expectedCrc = crc32(Buffer.from(dataForCrc));

    const actualCrc =
      (pat[pat.length - 4] << 24) |
      (pat[pat.length - 3] << 16) |
      (pat[pat.length - 2] << 8) |
      pat[pat.length - 1];

    expect(actualCrc >>> 0).toBe(expectedCrc);
  });

  it('has section_length of 13 (9 fixed bytes + 4 CRC, reported without first 3 bytes)', () => {
    const pat = buildPAT(PMT_PID);
    // section_length = lower 12 bits of bytes [1..2]
    const sectionLength = ((pat[1] & 0x0F) << 8) | pat[2];
    // section_length covers: transport_stream_id(2) + version(1) + sec_num(1) + last_sec_num(1)
    //                       + program_entry(4) + CRC32(4) = 13
    expect(sectionLength).toBe(13);
  });

  it('has transport_stream_id of 0x0001', () => {
    const pat = buildPAT(PMT_PID);
    const tsid = (pat[3] << 8) | pat[4];
    expect(tsid).toBe(0x0001);
  });

  it('has current_next_indicator set (bit 0 of byte 5)', () => {
    const pat = buildPAT(PMT_PID);
    expect(pat[5] & 0x01).toBe(1);
  });
});

describe('buildPMT', () => {
  it('starts with table_id 0x02', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    expect(pmt[0]).toBe(0x02);
  });

  it('sets section_syntax_indicator (bit 7 of byte 1)', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    expect((pmt[1] >> 7) & 0x01).toBe(1);
  });

  it('contains video stream entry with stream type 0x1B (H.264)', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    // PMT layout:
    //   [0]     table_id = 0x02
    //   [1..2]  section_syntax_indicator | reserved | section_length
    //   [3..4]  program_number
    //   [5]     version/current_next
    //   [6]     section_number
    //   [7]     last_section_number
    //   [8..9]  reserved(3) | PCR_PID(13)
    //   [10..11] reserved(4) | program_info_length(12) = 0
    //   Stream entries start at [12]:
    //     stream_type(1) + reserved(3)|PID(13) + reserved(4)|ES_info_length(12)
    const videoStreamType = pmt[12];
    expect(videoStreamType).toBe(STREAM_TYPE_H264);
  });

  it('contains video PID in video stream entry', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    const videoPidEncoded = ((pmt[13] & 0x1F) << 8) | pmt[14];
    expect(videoPidEncoded).toBe(VIDEO_PID);
  });

  it('contains audio stream entry with stream type 0x0F (AAC)', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    // Audio entry starts 5 bytes after video entry (stream entries are 5 bytes each)
    const audioStreamType = pmt[17];
    expect(audioStreamType).toBe(STREAM_TYPE_AAC);
  });

  it('contains audio PID in audio stream entry', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    const audioPidEncoded = ((pmt[18] & 0x1F) << 8) | pmt[19];
    expect(audioPidEncoded).toBe(AUDIO_PID);
  });

  it('uses video PID as PCR PID', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    const pcrPid = ((pmt[8] & 0x1F) << 8) | pmt[9];
    expect(pcrPid).toBe(VIDEO_PID);
  });

  it('has program_info_length of 0', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    const programInfoLength = ((pmt[10] & 0x0F) << 8) | pmt[11];
    expect(programInfoLength).toBe(0);
  });

  it('ends with a valid CRC32', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    const dataForCrc = pmt.subarray(0, pmt.length - 4);
    const expectedCrc = crc32(Buffer.from(dataForCrc));

    const actualCrc =
      (pmt[pmt.length - 4] << 24) |
      (pmt[pmt.length - 3] << 16) |
      (pmt[pmt.length - 2] << 8) |
      pmt[pmt.length - 1];

    expect(actualCrc >>> 0).toBe(expectedCrc);
  });

  it('has program_number of 1', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    const programNumber = (pmt[3] << 8) | pmt[4];
    expect(programNumber).toBe(1);
  });

  it('has current_next_indicator set (bit 0 of byte 5)', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    expect(pmt[5] & 0x01).toBe(1);
  });

  it('works with custom video and audio PIDs', () => {
    const customVideo = 0x0200;
    const customAudio = 0x0201;
    const pmt = buildPMT(customVideo, customAudio);

    const pcrPid = ((pmt[8] & 0x1F) << 8) | pmt[9];
    expect(pcrPid).toBe(customVideo);

    const videoPid = ((pmt[13] & 0x1F) << 8) | pmt[14];
    expect(videoPid).toBe(customVideo);

    const audioPid = ((pmt[18] & 0x1F) << 8) | pmt[19];
    expect(audioPid).toBe(customAudio);
  });
});
