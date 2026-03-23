import { TS_PACKET_SIZE, STREAM_TYPE_H264, STREAM_TYPE_AAC, NAL_TYPE_IDR } from '../../shared/types.js';

export interface DemuxedSample {
  pts: number;
  dts?: number;
  data: Uint8Array;
  isKeyframe?: boolean;
}

export interface DemuxResult {
  videoSamples: DemuxedSample[];
  audioSamples: DemuxedSample[];
}

/** Decode the 5-byte PTS/DTS timestamp encoding used in PES headers. */
function decodeTimestamp(data: Uint8Array, off: number): number {
  return (
    ((data[off] >> 1) & 0x07) * 0x40000000 +
    (data[off + 1] << 22) +
    ((data[off + 2] >> 1) << 15) +
    (data[off + 3] << 7) +
    (data[off + 4] >> 1)
  );
}

/** Return true if the Annex B payload contains a NAL unit of type IDR (5). */
function containsIDR(payload: Uint8Array): boolean {
  const len = payload.length;
  for (let i = 0; i + 3 < len; i++) {
    if (
      payload[i] === 0x00 &&
      payload[i + 1] === 0x00 &&
      (
        // 4-byte start code: 00 00 00 01
        (payload[i + 2] === 0x00 && i + 4 < len && payload[i + 3] === 0x01 && (payload[i + 4] & 0x1F) === NAL_TYPE_IDR) ||
        // 3-byte start code: 00 00 01
        (payload[i + 2] === 0x01 && (payload[i + 3] & 0x1F) === NAL_TYPE_IDR)
      )
    ) {
      return true;
    }
  }
  return false;
}

interface PESBuffer {
  data: Uint8Array[];
  totalLength: number;
}

export class TSDemuxer {
  videoPid: number = -1;
  audioPid: number = -1;

  private pmtPid: number = -1;
  private videoBuffer: PESBuffer | null = null;
  private audioBuffer: PESBuffer | null = null;
  private videoPts: number = 0;
  private videoDts: number | undefined = undefined;
  private audioPts: number = 0;
  private audioDts: number | undefined = undefined;

  /**
   * Demux a raw .ts segment (multiple 188-byte packets) and return video and
   * audio samples with PTS/DTS timestamps.
   */
  demux(data: Uint8Array): DemuxResult {
    const videoSamples: DemuxedSample[] = [];
    const audioSamples: DemuxedSample[] = [];

    const numPackets = Math.floor(data.length / TS_PACKET_SIZE);

    for (let pktIdx = 0; pktIdx < numPackets; pktIdx++) {
      const offset = pktIdx * TS_PACKET_SIZE;

      // Validate sync byte
      if (data[offset] !== 0x47) {
        continue;
      }

      // Parse header
      const byte1 = data[offset + 1];
      const byte2 = data[offset + 2];
      const byte3 = data[offset + 3];

      const pusi = (byte1 >> 6) & 0x01;  // payload_unit_start_indicator
      const pid = ((byte1 & 0x1F) << 8) | byte2;
      const adaptationFieldControl = (byte3 >> 4) & 0x03;

      // Determine payload start
      let payloadStart = offset + 4;

      // Handle adaptation field
      if (adaptationFieldControl === 0x02 || adaptationFieldControl === 0x03) {
        const afLength = data[payloadStart];
        payloadStart += 1 + afLength; // skip length byte + adaptation field
      }

      // No payload
      if (adaptationFieldControl === 0x02) {
        continue;
      }

      // Payload end is always at offset + 188
      const payloadEnd = offset + TS_PACKET_SIZE;
      if (payloadStart >= payloadEnd) {
        continue;
      }

      // --- PAT (PID 0x0000) ---
      if (pid === 0x0000) {
        this.parsePAT(data, payloadStart, payloadEnd);
        continue;
      }

      // --- PMT ---
      if (pid === this.pmtPid) {
        this.parsePMT(data, payloadStart, payloadEnd);
        continue;
      }

      // --- Video PES ---
      if (pid === this.videoPid) {
        if (pusi) {
          // Flush previous PES
          if (this.videoBuffer !== null) {
            const sample = this.buildSample(this.videoBuffer, this.videoPts, this.videoDts, true);
            if (sample) videoSamples.push(sample);
          }
          // Start new PES
          this.videoBuffer = { data: [], totalLength: 0 };
          const [pts, dts, headerLen] = this.parsePESHeader(data, payloadStart, payloadEnd);
          this.videoPts = pts;
          this.videoDts = dts;
          const pesPayloadStart = payloadStart + headerLen;
          if (pesPayloadStart < payloadEnd) {
            const chunk = data.slice(pesPayloadStart, payloadEnd);
            this.videoBuffer.data.push(chunk);
            this.videoBuffer.totalLength += chunk.length;
          }
        } else if (this.videoBuffer !== null) {
          const chunk = data.slice(payloadStart, payloadEnd);
          this.videoBuffer.data.push(chunk);
          this.videoBuffer.totalLength += chunk.length;
        }
        continue;
      }

      // --- Audio PES ---
      if (pid === this.audioPid) {
        if (pusi) {
          // Flush previous PES
          if (this.audioBuffer !== null) {
            const sample = this.buildSample(this.audioBuffer, this.audioPts, this.audioDts, false);
            if (sample) audioSamples.push(sample);
          }
          // Start new PES
          this.audioBuffer = { data: [], totalLength: 0 };
          const [pts, dts, headerLen] = this.parsePESHeader(data, payloadStart, payloadEnd);
          this.audioPts = pts;
          this.audioDts = dts;
          const pesPayloadStart = payloadStart + headerLen;
          if (pesPayloadStart < payloadEnd) {
            const chunk = data.slice(pesPayloadStart, payloadEnd);
            this.audioBuffer.data.push(chunk);
            this.audioBuffer.totalLength += chunk.length;
          }
        } else if (this.audioBuffer !== null) {
          const chunk = data.slice(payloadStart, payloadEnd);
          this.audioBuffer.data.push(chunk);
          this.audioBuffer.totalLength += chunk.length;
        }
        continue;
      }
    }

    // Flush remaining buffers
    if (this.videoBuffer !== null) {
      const sample = this.buildSample(this.videoBuffer, this.videoPts, this.videoDts, true);
      if (sample) videoSamples.push(sample);
      this.videoBuffer = null;
    }
    if (this.audioBuffer !== null) {
      const sample = this.buildSample(this.audioBuffer, this.audioPts, this.audioDts, false);
      if (sample) audioSamples.push(sample);
      this.audioBuffer = null;
    }

    return { videoSamples, audioSamples };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Parse PAT section to find the PMT PID. */
  private parsePAT(data: Uint8Array, start: number, end: number): void {
    // Skip pointer field if PUSI (already consumed by caller context)
    // PAT payload starts with a pointer_field byte
    let pos = start;
    const pointerField = data[pos++];
    pos += pointerField; // skip to start of section

    // table_id should be 0x00
    if (pos >= end || data[pos] !== 0x00) return;
    pos++; // table_id

    // section_syntax_indicator + section_length
    if (pos + 1 >= end) return;
    const sectionLength = ((data[pos] & 0x0F) << 8) | data[pos + 1];
    pos += 2;

    // transport_stream_id (2 bytes) + version/cc (1 byte) + section_number (1) + last_section_number (1)
    pos += 5;

    // Parse program entries: each is 4 bytes (program_number + PMT_PID)
    // Section ends at start-of-section + sectionLength, minus 4 bytes for CRC
    const sectionEnd = (start + 1 + pointerField + 3 + sectionLength) - 4; // -4 for CRC32
    while (pos + 3 < sectionEnd && pos + 3 < end) {
      const programNumber = (data[pos] << 8) | data[pos + 1];
      pos += 2;
      const pmtPid = ((data[pos] & 0x1F) << 8) | data[pos + 1];
      pos += 2;

      if (programNumber !== 0) {
        this.pmtPid = pmtPid;
        return; // take the first non-null program
      }
    }
  }

  /** Parse PMT section to find video and audio PIDs. */
  private parsePMT(data: Uint8Array, start: number, end: number): void {
    let pos = start;
    const pointerField = data[pos++];
    pos += pointerField;

    // table_id should be 0x02
    if (pos >= end || data[pos] !== 0x02) return;
    pos++; // table_id

    // section_length
    if (pos + 1 >= end) return;
    const sectionLength = ((data[pos] & 0x0F) << 8) | data[pos + 1];
    pos += 2;

    // program_number(2) + version(1) + section_number(1) + last_section_number(1) + PCR_PID(2)
    pos += 7;

    // program_info_length
    if (pos + 1 >= end) return;
    const programInfoLength = ((data[pos] & 0x0F) << 8) | data[pos + 1];
    pos += 2;
    pos += programInfoLength; // skip program descriptors

    // Parse stream entries until end of section (minus 4-byte CRC)
    const sectionEnd = (start + 1 + pointerField + 3 + sectionLength) - 4;
    while (pos + 4 < sectionEnd && pos + 4 < end) {
      const streamType = data[pos++];
      const streamPid = ((data[pos] & 0x1F) << 8) | data[pos + 1];
      pos += 2;
      const esInfoLength = ((data[pos] & 0x0F) << 8) | data[pos + 1];
      pos += 2;
      pos += esInfoLength; // skip ES descriptors

      if (streamType === STREAM_TYPE_H264 && this.videoPid === -1) {
        this.videoPid = streamPid;
      } else if (streamType === STREAM_TYPE_AAC && this.audioPid === -1) {
        this.audioPid = streamPid;
      }
    }
  }

  /**
   * Parse a PES header at the given position and return [pts, dts, totalHeaderBytes].
   * totalHeaderBytes is the number of bytes consumed from payloadStart through
   * the end of the PES optional header (ready for the ES payload).
   */
  private parsePESHeader(data: Uint8Array, start: number, end: number): [number, number | undefined, number] {
    // Minimum PES header: start_code(3) + stream_id(1) + packet_length(2) + optional_header(>=3) = 9 bytes
    if (start + 9 > end) return [0, undefined, 0];

    // Validate start code prefix: 0x00 0x00 0x01
    if (data[start] !== 0x00 || data[start + 1] !== 0x00 || data[start + 2] !== 0x01) {
      return [0, undefined, 0];
    }

    // stream_id at byte 3, packet_length at bytes 4-5
    // flags1 at byte 6, flags2 at byte 7, header_data_length at byte 8
    const flags2 = data[start + 7];
    const headerDataLength = data[start + 8];

    const ptsDtsFlags = (flags2 >> 6) & 0x03;

    let pts = 0;
    let dts: number | undefined = undefined;
    const optionalHeaderBase = start + 9; // first byte of header data

    if (ptsDtsFlags === 0x02 || ptsDtsFlags === 0x03) {
      // PTS present
      if (optionalHeaderBase + 5 <= end) {
        pts = decodeTimestamp(data, optionalHeaderBase);
      }
    }

    if (ptsDtsFlags === 0x03) {
      // DTS present
      if (optionalHeaderBase + 10 <= end) {
        dts = decodeTimestamp(data, optionalHeaderBase + 5);
      }
    }

    // Total header bytes = start_code(3) + stream_id(1) + packet_length(2) + flags1(1) + flags2(1) + header_data_length(1) + headerDataLength
    const totalHeaderBytes = 9 + headerDataLength;
    return [pts, dts, totalHeaderBytes];
  }

  /** Concatenate a PES buffer's chunks into a single Uint8Array and build a DemuxedSample. */
  private buildSample(
    buf: PESBuffer,
    pts: number,
    dts: number | undefined,
    checkKeyframe: boolean,
  ): DemuxedSample | null {
    if (buf.totalLength === 0) return null;

    const payload = new Uint8Array(buf.totalLength);
    let offset = 0;
    for (const chunk of buf.data) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }

    const sample: DemuxedSample = { pts, data: payload };
    if (dts !== undefined) sample.dts = dts;
    if (checkKeyframe) {
      sample.isKeyframe = containsIDR(payload);
    }
    return sample;
  }
}
