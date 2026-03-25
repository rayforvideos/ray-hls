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

/** PES 헤더에 사용되는 5바이트 PTS/DTS 타임스탬프 인코딩을 디코딩한다. */
function decodeTimestamp(data: Uint8Array, off: number): number {
  return (
    ((data[off] >> 1) & 0x07) * 0x40000000 +
    (data[off + 1] << 22) +
    ((data[off + 2] >> 1) << 15) +
    (data[off + 3] << 7) +
    (data[off + 4] >> 1)
  );
}

/** Annex B 페이로드에 IDR(5) 타입 NAL 유닛이 포함되어 있으면 true를 반환한다. */
function containsIDR(payload: Uint8Array): boolean {
  const len = payload.length;
  for (let i = 0; i + 3 < len; i++) {
    if (
      payload[i] === 0x00 &&
      payload[i + 1] === 0x00 &&
      (
        // 4바이트 시작 코드: 00 00 00 01
        (payload[i + 2] === 0x00 && i + 4 < len && payload[i + 3] === 0x01 && (payload[i + 4] & 0x1F) === NAL_TYPE_IDR) ||
        // 3바이트 시작 코드: 00 00 01
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
   * 원시 .ts 세그먼트(다수의 188바이트 패킷)를 디먹싱하여
   * PTS/DTS 타임스탬프가 포함된 비디오 및 오디오 샘플을 반환한다.
   */
  demux(data: Uint8Array): DemuxResult {
    const videoSamples: DemuxedSample[] = [];
    const audioSamples: DemuxedSample[] = [];

    const numPackets = Math.floor(data.length / TS_PACKET_SIZE);

    for (let pktIdx = 0; pktIdx < numPackets; pktIdx++) {
      const offset = pktIdx * TS_PACKET_SIZE;

      // 동기 바이트 검증
      if (data[offset] !== 0x47) {
        continue;
      }

      // 헤더 파싱
      const byte1 = data[offset + 1];
      const byte2 = data[offset + 2];
      const byte3 = data[offset + 3];

      const pusi = (byte1 >> 6) & 0x01;  // payload_unit_start_indicator
      const pid = ((byte1 & 0x1F) << 8) | byte2;
      const adaptationFieldControl = (byte3 >> 4) & 0x03;

      // 페이로드 시작 위치 결정
      let payloadStart = offset + 4;

      // 적응 필드 처리
      if (adaptationFieldControl === 0x02 || adaptationFieldControl === 0x03) {
        const afLength = data[payloadStart];
        payloadStart += 1 + afLength; // 길이 바이트 + 적응 필드 건너뛰기
      }

      // 페이로드 없음
      if (adaptationFieldControl === 0x02) {
        continue;
      }

      // 페이로드 끝은 항상 offset + 188
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

      // --- 비디오 PES ---
      if (pid === this.videoPid) {
        if (pusi) {
          // 이전 PES 플러시
          if (this.videoBuffer !== null) {
            const sample = this.buildSample(this.videoBuffer, this.videoPts, this.videoDts, true);
            if (sample) videoSamples.push(sample);
          }
          // 새 PES 시작
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

      // --- 오디오 PES ---
      if (pid === this.audioPid) {
        if (pusi) {
          // 이전 PES 플러시
          if (this.audioBuffer !== null) {
            const sample = this.buildSample(this.audioBuffer, this.audioPts, this.audioDts, false);
            if (sample) audioSamples.push(sample);
          }
          // 새 PES 시작
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

    // 남은 버퍼 플러시
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
  // 내부 헬퍼 메서드
  // ---------------------------------------------------------------------------

  /** PAT 섹션을 파싱하여 PMT PID를 찾는다. */
  private parsePAT(data: Uint8Array, start: number, end: number): void {
    // 포인터 필드 건너뛰기
    let pos = start;
    const pointerField = data[pos++];
    pos += pointerField; // 섹션 시작으로 이동

    // table_id는 0x00이어야 함
    if (pos >= end || data[pos] !== 0x00) return;
    pos++; // table_id

    // section_syntax_indicator + section_length
    if (pos + 1 >= end) return;
    const sectionLength = ((data[pos] & 0x0F) << 8) | data[pos + 1];
    pos += 2;

    // transport_stream_id(2바이트) + version/cc(1바이트) + section_number(1) + last_section_number(1)
    pos += 5;

    // 프로그램 항목 파싱: 각 4바이트 (program_number + PMT_PID)
    // 섹션 끝 = 섹션 시작 + sectionLength - CRC32 4바이트
    const sectionEnd = (start + 1 + pointerField + 3 + sectionLength) - 4;
    while (pos + 3 < sectionEnd && pos + 3 < end) {
      const programNumber = (data[pos] << 8) | data[pos + 1];
      pos += 2;
      const pmtPid = ((data[pos] & 0x1F) << 8) | data[pos + 1];
      pos += 2;

      if (programNumber !== 0) {
        this.pmtPid = pmtPid;
        return; // 첫 번째 non-null 프로그램 사용
      }
    }
  }

  /** PMT 섹션을 파싱하여 비디오 및 오디오 PID를 찾는다. */
  private parsePMT(data: Uint8Array, start: number, end: number): void {
    let pos = start;
    const pointerField = data[pos++];
    pos += pointerField;

    // table_id는 0x02여야 함
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
    pos += programInfoLength; // 프로그램 디스크립터 건너뛰기

    // 섹션 끝(CRC32 4바이트 제외)까지 스트림 항목 파싱
    const sectionEnd = (start + 1 + pointerField + 3 + sectionLength) - 4;
    while (pos + 4 < sectionEnd && pos + 4 < end) {
      const streamType = data[pos++];
      const streamPid = ((data[pos] & 0x1F) << 8) | data[pos + 1];
      pos += 2;
      const esInfoLength = ((data[pos] & 0x0F) << 8) | data[pos + 1];
      pos += 2;
      pos += esInfoLength; // ES 디스크립터 건너뛰기

      if (streamType === STREAM_TYPE_H264 && this.videoPid === -1) {
        this.videoPid = streamPid;
      } else if (streamType === STREAM_TYPE_AAC && this.audioPid === -1) {
        this.audioPid = streamPid;
      }
    }
  }

  /**
   * 지정된 위치의 PES 헤더를 파싱하여 [pts, dts, 전체헤더바이트수]를 반환한다.
   * 전체헤더바이트수는 payloadStart부터 PES 선택적 헤더 끝까지 소비한 바이트 수
   * (ES 페이로드 시작 준비 완료).
   */
  private parsePESHeader(data: Uint8Array, start: number, end: number): [number, number | undefined, number] {
    // 최소 PES 헤더: start_code(3) + stream_id(1) + packet_length(2) + optional_header(>=3) = 9바이트
    if (start + 9 > end) return [0, undefined, 0];

    // 시작 코드 접두사 검증: 0x00 0x00 0x01
    if (data[start] !== 0x00 || data[start + 1] !== 0x00 || data[start + 2] !== 0x01) {
      return [0, undefined, 0];
    }

    // 바이트 3: stream_id, 바이트 4-5: packet_length
    // 바이트 6: flags1, 바이트 7: flags2, 바이트 8: header_data_length
    const flags2 = data[start + 7];
    const headerDataLength = data[start + 8];

    const ptsDtsFlags = (flags2 >> 6) & 0x03;

    let pts = 0;
    let dts: number | undefined = undefined;
    const optionalHeaderBase = start + 9; // 헤더 데이터의 첫 바이트

    if (ptsDtsFlags === 0x02 || ptsDtsFlags === 0x03) {
      // PTS 존재
      if (optionalHeaderBase + 5 <= end) {
        pts = decodeTimestamp(data, optionalHeaderBase);
      }
    }

    if (ptsDtsFlags === 0x03) {
      // DTS 존재
      if (optionalHeaderBase + 10 <= end) {
        dts = decodeTimestamp(data, optionalHeaderBase + 5);
      }
    }

    // 전체 헤더 바이트 = start_code(3) + stream_id(1) + packet_length(2) + flags1(1) + flags2(1) + header_data_length(1) + headerDataLength
    const totalHeaderBytes = 9 + headerDataLength;
    return [pts, dts, totalHeaderBytes];
  }

  /** PES 버퍼의 청크를 단일 Uint8Array로 합치고 DemuxedSample을 생성한다. */
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
