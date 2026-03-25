import crypto from 'crypto';

export function validateC0(data: Buffer): boolean {
  return data[0] === 0x03;
}

export function generateS0S1S2(c1: Buffer): Buffer {
  // S0: 1바이트 버전
  const s0 = Buffer.alloc(1);
  s0[0] = 0x03;

  // S1: 타임스탬프(4) + 제로(4) + 랜덤(1528) = 1536바이트
  const s1 = Buffer.alloc(1536);
  const timestamp = Math.floor(Date.now() / 1000);
  s1.writeUInt32BE(timestamp, 0);
  s1.writeUInt32BE(0, 4);
  const random = crypto.randomBytes(1528);
  random.copy(s1, 8);

  // S2: C1의 에코 (바이트 4-7에 서버 타임스탬프 삽입) = 1536바이트
  const s2 = Buffer.alloc(1536);
  c1.copy(s2);
  // 바이트 4-7을 서버 타임스탬프로 덮어쓰기
  s2.writeUInt32BE(timestamp, 4);

  return Buffer.concat([s0, s1, s2]);
}
