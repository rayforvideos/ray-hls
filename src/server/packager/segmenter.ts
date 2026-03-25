import {
  PTS_CLOCK_RATE,
  NAL_TYPE_IDR,
  NAL_TYPE_SPS,
  NAL_TYPE_PPS,
} from '../../shared/types.js';

export interface SegmenterResult {
  isNewSegment: boolean;
  completedSegmentDuration?: number; // 초 단위
  nalUnits: Buffer[];
}

/**
 * Annex B 바이트 스트림을 파싱하여 개별 NAL 유닛 버퍼를 추출한다
 * (시작 코드 제외).
 *
 * 3바이트(0x000001) 및 4바이트(0x00000001) 시작 코드를 모두 지원한다.
 */
function parseAnnexB(data: Buffer): Buffer[] {
  const nalUnits: Buffer[] = [];
  let i = 0;
  const len = data.length;

  // 첫 번째 시작 코드 탐색
  let nalStart = -1;
  while (i < len - 2) {
    if (data[i] === 0x00 && data[i + 1] === 0x00) {
      if (data[i + 2] === 0x01) {
        // 3바이트 시작 코드
        if (nalStart !== -1) {
          nalUnits.push(data.subarray(nalStart, i));
        }
        i += 3;
        nalStart = i;
        continue;
      } else if (i + 3 < len && data[i + 2] === 0x00 && data[i + 3] === 0x01) {
        // 4바이트 시작 코드
        if (nalStart !== -1) {
          nalUnits.push(data.subarray(nalStart, i));
        }
        i += 4;
        nalStart = i;
        continue;
      }
    }
    i++;
  }

  // 후행 NAL 유닛 캡처
  if (nalStart !== -1 && nalStart < len) {
    nalUnits.push(data.subarray(nalStart, len));
  }

  return nalUnits;
}

export class Segmenter {
  /** -1에서 시작; 첫 IDR에서 0이 되며, 이후 IDR마다 증가한다. */
  currentSegmentIndex: number = -1;

  /** 가장 최근에 수신된 SPS NAL 유닛 (시작 코드 제외), 또는 null. */
  sps: Buffer | null = null;

  /** 가장 최근에 수신된 PPS NAL 유닛 (시작 코드 제외), 또는 null. */
  pps: Buffer | null = null;

  /** 현재 세그먼트가 시작된 PTS (90kHz 틱). */
  private segmentStartPts: number = 0;

  /**
   * Annex B로 인코딩된 비디오 데이터 청크를 PTS와 함께 푸시한다.
   *
   * IDR(새 세그먼트 경계)이 발견되었는지, 완료된 세그먼트의 구간(있는 경우),
   * 파싱된 NAL 유닛 목록을 포함한 결과를 반환한다.
   */
  pushVideoData(data: Buffer, pts: number): SegmenterResult {
    const nalUnits = parseAnnexB(data);

    let isNewSegment = false;
    let completedSegmentDuration: number | undefined;

    for (const nal of nalUnits) {
      if (nal.length === 0) continue;

      const nalType = nal[0] & 0x1F;

      if (nalType === NAL_TYPE_SPS) {
        this.sps = Buffer.from(nal);
      } else if (nalType === NAL_TYPE_PPS) {
        this.pps = Buffer.from(nal);
      } else if (nalType === NAL_TYPE_IDR) {
        // 첫 IDR이 아니라면 방금 완료된 세그먼트의 구간을 계산
        if (this.currentSegmentIndex >= 0) {
          completedSegmentDuration = (pts - this.segmentStartPts) / PTS_CLOCK_RATE;
        }
        this.currentSegmentIndex++;
        this.segmentStartPts = pts;
        isNewSegment = true;
      }
    }

    return { isNewSegment, completedSegmentDuration, nalUnits };
  }
}
