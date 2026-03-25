/**
 * ISO BMFF (MP4) 박스 구성을 위한 저수준 헬퍼.
 * 모든 연산은 브라우저 호환성을 위해 Uint8Array/DataView를 사용한다.
 */

/** 여러 Uint8Array를 하나로 합친다. */
export function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** 32비트 부호 없는 정수를 빅엔디안 4바이트로 인코딩한다. */
export function uint32(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, value >>> 0, false);
  return buf;
}

/** 16비트 부호 없는 정수를 빅엔디안 2바이트로 인코딩한다. */
export function uint16(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  const view = new DataView(buf.buffer);
  view.setUint16(0, value & 0xffff, false);
  return buf;
}

/** 8비트 부호 없는 정수를 1바이트로 인코딩한다. */
export function uint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

/**
 * MP4 박스 생성: 4바이트 크기(빅엔디안) + 4바이트 ASCII 타입 + 페이로드.
 */
export function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  let payloadSize = 0;
  for (const p of payloads) {
    payloadSize += p.length;
  }
  const size = 8 + payloadSize; // 4(크기) + 4(타입) + 페이로드
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, size, false);
  header[4] = type.charCodeAt(0);
  header[5] = type.charCodeAt(1);
  header[6] = type.charCodeAt(2);
  header[7] = type.charCodeAt(3);
  return concat(header, ...payloads);
}

/**
 * Full box 생성: 버전(1바이트) + 플래그(3바이트)가 페이로드 앞에 추가된 박스.
 */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payloads: Uint8Array[]
): Uint8Array {
  const versionFlags = new Uint8Array(4);
  versionFlags[0] = version & 0xff;
  versionFlags[1] = (flags >>> 16) & 0xff;
  versionFlags[2] = (flags >>> 8) & 0xff;
  versionFlags[3] = flags & 0xff;
  return box(type, versionFlags, ...payloads);
}
