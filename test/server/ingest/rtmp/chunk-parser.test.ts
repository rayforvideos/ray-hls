import { describe, it, expect } from 'vitest';
import {
  parseChunkHeader,
  CHUNK_HEADER_TYPE,
  MSG_TYPE_AUDIO,
  MSG_TYPE_VIDEO,
  MSG_TYPE_COMMAND_AMF0,
  MSG_TYPE_DATA_AMF0,
} from '../../../../src/server/ingest/rtmp/chunk-parser.js';

describe('parseChunkHeader', () => {
  it('parses a Type 0 header (12 bytes)', () => {
    // fmt=0 (bits 7-6 = 00), csid=3 (bits 5-0 = 000011)
    // byte0: 0x03
    // timestamp: 3 bytes = 0x000064 (100)
    // messageLength: 3 bytes = 0x000200 (512)
    // messageTypeId: 1 byte = 0x09 (video)
    // messageStreamId: 4 bytes LE = 0x01 0x00 0x00 0x00 (1)
    const buf = Buffer.from([
      0x03,             // fmt=0, csid=3
      0x00, 0x00, 0x64, // timestamp = 100
      0x00, 0x02, 0x00, // messageLength = 512
      0x09,             // messageTypeId = 9 (video)
      0x01, 0x00, 0x00, 0x00, // messageStreamId = 1 (LE)
    ]);

    const header = parseChunkHeader(buf);
    expect(header.fmt).toBe(CHUNK_HEADER_TYPE.TYPE_0);
    expect(header.csid).toBe(3);
    expect(header.timestamp).toBe(100);
    expect(header.messageLength).toBe(512);
    expect(header.messageTypeId).toBe(MSG_TYPE_VIDEO);
    expect(header.messageStreamId).toBe(1);
    expect(header.headerSize).toBe(12);
  });

  it('parses a Type 1 header (8 bytes)', () => {
    // fmt=1 (bits 7-6 = 01), csid=5
    // byte0: 0b01_000101 = 0x45
    // timestampDelta: 3 bytes = 0x000028 (40)
    // messageLength: 3 bytes = 0x000100 (256)
    // messageTypeId: 1 byte = 0x08 (audio)
    const buf = Buffer.from([
      0x45,             // fmt=1, csid=5
      0x00, 0x00, 0x28, // timestampDelta = 40
      0x00, 0x01, 0x00, // messageLength = 256
      0x08,             // messageTypeId = 8 (audio)
    ]);

    const header = parseChunkHeader(buf);
    expect(header.fmt).toBe(CHUNK_HEADER_TYPE.TYPE_1);
    expect(header.csid).toBe(5);
    expect(header.timestampDelta).toBe(40);
    expect(header.messageLength).toBe(256);
    expect(header.messageTypeId).toBe(MSG_TYPE_AUDIO);
    expect(header.headerSize).toBe(8);
  });

  it('parses a Type 2 header (4 bytes)', () => {
    // fmt=2 (bits 7-6 = 10), csid=4
    // byte0: 0b10_000100 = 0x84
    // timestampDelta: 3 bytes = 0x000032 (50)
    const buf = Buffer.from([
      0x84,             // fmt=2, csid=4
      0x00, 0x00, 0x32, // timestampDelta = 50
    ]);

    const header = parseChunkHeader(buf);
    expect(header.fmt).toBe(CHUNK_HEADER_TYPE.TYPE_2);
    expect(header.csid).toBe(4);
    expect(header.timestampDelta).toBe(50);
    expect(header.headerSize).toBe(4);
  });

  it('parses a Type 3 header (1 byte)', () => {
    // fmt=3 (bits 7-6 = 11), csid=2
    // byte0: 0b11_000010 = 0xC2
    const buf = Buffer.from([0xC2]);
    const header = parseChunkHeader(buf);
    expect(header.fmt).toBe(CHUNK_HEADER_TYPE.TYPE_3);
    expect(header.csid).toBe(2);
    expect(header.headerSize).toBe(1);
  });

  it('handles extended csid=0 (2-byte csid)', () => {
    // fmt=0, csid=0 → next byte + 64
    // byte0: 0x00 (fmt=0, csid=0), next byte: 10 → csid = 10 + 64 = 74
    const buf = Buffer.from([
      0x00,             // fmt=0, csid=0 (extended)
      0x0A,             // extra byte: 10
      0x00, 0x00, 0x00, // timestamp
      0x00, 0x00, 0x10, // messageLength = 16
      0x14,             // messageTypeId = 0x14 (AMF0 command)
      0x00, 0x00, 0x00, 0x00, // messageStreamId
    ]);

    const header = parseChunkHeader(buf);
    expect(header.csid).toBe(74); // 10 + 64
    expect(header.fmt).toBe(0);
    expect(header.messageTypeId).toBe(MSG_TYPE_COMMAND_AMF0);
  });

  it('exports correct message type constants', () => {
    expect(MSG_TYPE_AUDIO).toBe(0x08);
    expect(MSG_TYPE_VIDEO).toBe(0x09);
    expect(MSG_TYPE_COMMAND_AMF0).toBe(0x14);
    expect(MSG_TYPE_DATA_AMF0).toBe(0x12);
  });
});
