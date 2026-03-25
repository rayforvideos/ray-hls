import { EventEmitter } from 'events';
import { buildTSPacket } from './ts-packet.js';
import { buildPESPacket } from './pes-packet.js';
import { buildPAT, buildPMT } from './psi.js';
import { Segmenter } from './segmenter.js';
import {
  VIDEO_PID, AUDIO_PID, PAT_PID, PMT_PID,
  TS_PACKET_SIZE, SegmentInfo, QualityLevel,
} from '../../shared/types.js';

// 하위 모듈 재내보내기
export { Segmenter } from './segmenter.js';
export { buildTSPacket } from './ts-packet.js';
export { buildPESPacket } from './pes-packet.js';
export { buildPAT, buildPMT } from './psi.js';

/**
 * PES 버퍼를 하나 이상의 188바이트 TS 패킷으로 래핑한다.
 *
 * 첫 번째 패킷은 payloadUnitStart=true이며, 선택적으로 PCR을 포함한다.
 * 이후 패킷은 PES 페이로드의 연속 조각을 운반한다.
 *
 * 188바이트 TS 패킷 Buffer 배열과 갱신된 연속성 카운터 값을 반환한다.
 */
function pesToTSPackets(
  pes: Buffer,
  pid: number,
  cc: number,
  pcr?: number,
): { packets: Buffer[]; nextCC: number } {
  const packets: Buffer[] = [];
  const MAX_PAYLOAD = TS_PACKET_SIZE - 4; // 적응 필드 없이 184바이트

  let offset = 0;
  let first = true;

  while (offset < pes.length || first) {
    const isFirst = first;
    first = false;

    // 첫 패킷에 PCR이 있으면 적응 필드에 8바이트 필요
    // (afLen 1바이트 + 플래그 1바이트 + PCR 6바이트)
    const hasPCR = isFirst && pcr !== undefined;
    const afOverhead = hasPCR ? 8 : 0;
    const maxPayloadThisPacket = MAX_PAYLOAD - afOverhead;

    const slice = pes.subarray(offset, offset + maxPayloadThisPacket);
    offset += slice.length;

    const pkt = buildTSPacket({
      pid,
      payload: slice,
      payloadUnitStart: isFirst,
      continuityCounter: cc & 0x0F,
      pcr: hasPCR ? pcr : undefined,
    });

    packets.push(pkt);
    cc = (cc + 1) & 0x0F;
  }

  return { packets, nextCC: cc };
}

export class TSPackager extends EventEmitter {
  private quality: QualityLevel;
  private segmenter: Segmenter;

  // 현재 조립 중인 세그먼트의 버퍼된 TS 패킷들
  private segmentPackets: Buffer[] = [];

  // 연속성 카운터 (16에서 래핑)
  private ccPAT: number = 0;
  private ccPMT: number = 0;
  private ccVideo: number = 0;
  private ccAudio: number = 0;

  // 현재 채워지고 있는 세그먼트 인덱스 (-1 = 없음)
  private currentSegmentIndex: number = -1;

  // 현재 세그먼트가 시작된 PTS (플러시 시 구간 계산용)
  private segmentStartPts: number = 0;

  // 마지막으로 수신한 비디오 PTS (플러시 시 구간 추정용)
  private lastVideoPts: number = 0;

  constructor(quality: QualityLevel) {
    super();
    this.quality = quality;
    this.segmenter = new Segmenter();
  }

  /**
   * PTS(및 선택적 DTS)가 포함된 H.264 Annex B 원시 데이터를 푸시한다.
   *
   * 내부적으로 Segmenter에 이 프레임이 새 세그먼트를 시작하는지 확인한다.
   * 그렇다면 이전 세그먼트를 플러시하고, 새 세그먼트 시작 부분에
   * PAT + PMT를 기록한다.
   */
  pushVideo(data: Buffer, pts: number, dts?: number): void {
    this.lastVideoPts = pts;

    const result = this.segmenter.pushVideoData(data, pts);

    if (result.isNewSegment) {
      // --- 완료된 세그먼트 플러시 (있는 경우) ---
      if (this.currentSegmentIndex >= 0 && this.segmentPackets.length > 0) {
        const duration = result.completedSegmentDuration ?? 0;
        this._emitSegment(this.currentSegmentIndex, duration);
      }

      // --- 새 세그먼트 시작 ---
      this.currentSegmentIndex = this.segmenter.currentSegmentIndex;
      this.segmentStartPts = pts;
      this.segmentPackets = [];

      // 새 세그먼트 시작 부분에 PAT와 PMT 기록
      this._writePAT();
      this._writePMT();
    }

    // 활성 세그먼트가 있을 때만 패킷화 (즉, 첫 IDR이 수신된 이후)
    if (this.currentSegmentIndex < 0) return;

    // PES 구성 후 TS 패킷으로 패킷화
    const pes = buildPESPacket({
      streamId: 0xE0,
      payload: data,
      pts,
      dts,
    });

    const { packets, nextCC } = pesToTSPackets(pes, VIDEO_PID, this.ccVideo, pts);
    this.ccVideo = nextCC;
    for (const pkt of packets) this.segmentPackets.push(pkt);
  }

  /**
   * PTS가 포함된 AAC ADTS 원시 데이터를 푸시한다.
   */
  pushAudio(data: Buffer, pts: number): void {
    // 활성 세그먼트가 있을 때만 패킷화
    if (this.currentSegmentIndex < 0) return;

    const pes = buildPESPacket({
      streamId: 0xC0,
      payload: data,
      pts,
    });

    const { packets, nextCC } = pesToTSPackets(pes, AUDIO_PID, this.ccAudio);
    this.ccAudio = nextCC;
    for (const pkt of packets) this.segmentPackets.push(pkt);
  }

  /**
   * 마지막 (미완성될 수 있는) 세그먼트를 플러시한다.
   */
  flush(): void {
    if (this.currentSegmentIndex < 0 || this.segmentPackets.length === 0) return;

    const duration = (this.lastVideoPts - this.segmentStartPts) / 90_000;
    this._emitSegment(this.currentSegmentIndex, duration);

    // 상태 초기화
    this.segmentPackets = [];
    this.currentSegmentIndex = -1;
  }

  // ---------------------------------------------------------------------------
  // 내부 헬퍼 메서드
  // ---------------------------------------------------------------------------

  private _writePAT(): void {
    const patSection = buildPAT(PMT_PID);
    // MPEG-TS: PUSI=1인 섹션 운반 패킷은 pointer_field 바이트로 시작해야 함
    // (ISO 13818-1 §2.4.4.2). 0x00 값은 포인터 필드 직후 섹션이 시작됨을 의미
    const payload = Buffer.concat([Buffer.alloc(1, 0x00), patSection]);
    const pkt = buildTSPacket({
      pid: PAT_PID,
      payload,
      payloadUnitStart: true,
      continuityCounter: this.ccPAT & 0x0F,
    });
    this.ccPAT = (this.ccPAT + 1) & 0x0F;
    this.segmentPackets.push(pkt);
  }

  private _writePMT(): void {
    const pmtSection = buildPMT(VIDEO_PID, AUDIO_PID);
    // PAT와 동일한 pointer_field 요구 사항
    const payload = Buffer.concat([Buffer.alloc(1, 0x00), pmtSection]);
    const pkt = buildTSPacket({
      pid: PMT_PID,
      payload,
      payloadUnitStart: true,
      continuityCounter: this.ccPMT & 0x0F,
    });
    this.ccPMT = (this.ccPMT + 1) & 0x0F;
    this.segmentPackets.push(pkt);
  }

  private _emitSegment(index: number, duration: number): void {
    const data = Buffer.concat(this.segmentPackets);
    const info: SegmentInfo = {
      index,
      duration,
      filename: `seg-${index}.ts`,
      quality: this.quality,
      byteSize: data.length,
    };
    this.emit('segment', info, data);
  }
}
