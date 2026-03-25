export interface NALUnit {
  type: number;
  data: Uint8Array;
}

/**
 * Annex B 바이트 스트림을 파싱하여 3바이트(0x000001) 및 4바이트
 * (0x00000001) 시작 코드를 찾아 NAL 유닛을 추출한다.
 *
 * NAL 유닛 타입 = NAL 데이터의 첫 바이트 & 0x1F.
 */
export function parseNALUnits(data: Uint8Array): NALUnit[] {
  const units: NALUnit[] = [];
  const len = data.length;

  // 시작 코드 위치 수집 (시작 코드 이후 첫 NAL 바이트의 오프셋)
  const startOffsets: number[] = [];

  let i = 0;
  while (i < len) {
    // 3바이트(0x000001) 또는 4바이트(0x00000001) 시작 코드 탐색
    if (i + 2 < len && data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
      if (i > 0 && data[i - 1] === 0x00) {
        // 4바이트 시작 코드 — NAL 데이터는 i+3부터 시작
        startOffsets.push(i + 3);
      } else {
        // 3바이트 시작 코드
        startOffsets.push(i + 3);
      }
      i += 3;
      continue;
    }
    i++;
  }

  for (let j = 0; j < startOffsets.length; j++) {
    const start = startOffsets[j];
    // 끝은 다음 시작 코드의 선행 제로 바이트 이전, 또는 버퍼 끝.
    // 다음 startOffset는 시작 코드 접두사 이후 첫 바이트로 계산되었으므로
    // 다음 시작 코드를 구성하는 제로 바이트를 역추적해야 한다.
    let end: number;
    if (j + 1 < startOffsets.length) {
      end = startOffsets[j + 1] - 3; // "001"에 대해 최소 3바이트 역추적
      // 4바이트 시작 코드의 선행 0x00 바이트도 추가 역추적
      while (end > start && data[end - 1] === 0x00) {
        end--;
      }
    } else {
      end = len;
    }

    if (end > start) {
      const nalData = data.subarray(start, end);
      units.push({
        type: nalData[0] & 0x1F,
        data: nalData,
      });
    }
  }

  return units;
}
