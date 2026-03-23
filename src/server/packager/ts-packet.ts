import { TS_PACKET_SIZE } from '../../shared/types.js';

export interface TSPacketOptions {
  pid: number;
  payload: Buffer;
  payloadUnitStart: boolean;
  continuityCounter: number;
  pcr?: number; // 90kHz clock value
}

// PCR field is always 6 bytes (33-bit base + 6 reserved bits + 9-bit extension)
const PCR_FIELD_SIZE = 6;
// Adaptation field flags byte size
const AF_FLAGS_SIZE = 1;
// Adaptation field length byte size
const AF_LENGTH_BYTE_SIZE = 1;
// TS header size
const TS_HEADER_SIZE = 4;
// Maximum payload size in a TS packet with no adaptation field
const MAX_PAYLOAD_SIZE = TS_PACKET_SIZE - TS_HEADER_SIZE; // 184

/**
 * Encode a 90kHz PCR value into 6 bytes of adaptation field PCR data.
 * Layout: 33-bit base | 6 reserved bits (all 1) | 9-bit extension (0)
 *
 *  Byte 0: base[32:25]
 *  Byte 1: base[24:17]
 *  Byte 2: base[16:9]
 *  Byte 3: base[8:1]
 *  Byte 4: base[0] | reserved(111111) | ext[8]
 *  Byte 5: ext[7:0]
 */
function encodePCR(buf: Buffer, offset: number, pcr: number): void {
  const base = BigInt(pcr) & 0x1_ffff_ffffn; // 33 bits
  const ext = 0n; // always 0

  buf[offset + 0] = Number((base >> 25n) & 0xFFn);
  buf[offset + 1] = Number((base >> 17n) & 0xFFn);
  buf[offset + 2] = Number((base >> 9n) & 0xFFn);
  buf[offset + 3] = Number((base >> 1n) & 0xFFn);
  // bit7: base[0], bits6:1: reserved (111111), bit0: ext[8]
  buf[offset + 4] = Number(((base & 0x01n) << 7n) | (0x3Fn << 1n) | ((ext >> 8n) & 0x01n));
  buf[offset + 5] = Number(ext & 0xFFn);
}

export function buildTSPacket(opts: TSPacketOptions): Buffer {
  const { pid, payload, payloadUnitStart, continuityCounter, pcr } = opts;

  const hasPCR = pcr !== undefined;
  // Minimum adaptation field data size needed for PCR (flags byte + pcr bytes)
  const minAFDataSize = hasPCR ? AF_FLAGS_SIZE + PCR_FIELD_SIZE : AF_FLAGS_SIZE;

  // Determine if we need an adaptation field:
  // - PCR is present, OR
  // - payload is shorter than 184 bytes (stuffing needed)
  const needsAF = hasPCR || payload.length < MAX_PAYLOAD_SIZE;

  let adaptationFieldControl: number;
  let afLength: number; // value written into the adaptation_field_length byte

  if (!needsAF) {
    // Payload only
    adaptationFieldControl = 0x01;
    afLength = 0; // not used
  } else if (payload.length === 0) {
    // Adaptation field only (no payload)
    adaptationFieldControl = 0x02;
    // afLength fills all remaining space: 188 - 4 (header) - 1 (afLen byte) = 183
    afLength = MAX_PAYLOAD_SIZE - AF_LENGTH_BYTE_SIZE; // 183
  } else {
    // Adaptation field + payload
    adaptationFieldControl = 0x03;
    // afLength = 188 - 4 (header) - 1 (afLen byte) - payload.length
    afLength = MAX_PAYLOAD_SIZE - AF_LENGTH_BYTE_SIZE - payload.length;
  }

  // If adaptation field is needed but the calculated afLength is less than the
  // minimum AF data size (flags + optional PCR), we have a problem. In practice
  // the caller should ensure this doesn't happen, but guard just in case.
  // For afLength == 0, the adaptation field is present but empty (no flags byte).
  // ISO 13818-1 says afLength=0 is valid (single stuffing byte = afLen byte itself).

  const packet = Buffer.alloc(TS_PACKET_SIZE, 0x00);
  let pos = 0;

  // Byte 0: sync byte
  packet[pos++] = 0x47;

  // Bytes 1-2: TEI(0) | PUSI | Priority(0) | PID[12:0]
  const pusiBit = payloadUnitStart ? 0x40 : 0x00;
  packet[pos++] = pusiBit | ((pid >> 8) & 0x1F);
  packet[pos++] = pid & 0xFF;

  // Byte 3: scrambling(00) | AFC(2 bits) | CC(4 bits)
  packet[pos++] = ((adaptationFieldControl & 0x03) << 4) | (continuityCounter & 0x0F);

  // Adaptation field
  if (needsAF) {
    packet[pos++] = afLength; // adaptation_field_length

    if (afLength > 0) {
      // Flags byte
      const pcrFlag = hasPCR ? 0x10 : 0x00;
      packet[pos++] = pcrFlag; // discontinuity=0, random_access=0, priority=0, PCR_flag, rest=0

      if (hasPCR) {
        encodePCR(packet, pos, pcr!);
        pos += PCR_FIELD_SIZE;
      }

      // Stuffing: fill remaining adaptation field bytes with 0xFF
      const stuffingEnd = TS_HEADER_SIZE + AF_LENGTH_BYTE_SIZE + afLength;
      while (pos < stuffingEnd) {
        packet[pos++] = 0xFF;
      }
    }
  }

  // Payload
  if (payload.length > 0) {
    payload.copy(packet, pos);
  }

  return packet;
}
