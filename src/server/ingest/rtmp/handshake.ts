import crypto from 'crypto';

export function validateC0(data: Buffer): boolean {
  return data[0] === 0x03;
}

export function generateS0S1S2(c1: Buffer): Buffer {
  // S0: 1 byte version
  const s0 = Buffer.alloc(1);
  s0[0] = 0x03;

  // S1: timestamp(4) + zero(4) + random(1528) = 1536 bytes
  const s1 = Buffer.alloc(1536);
  const timestamp = Math.floor(Date.now() / 1000);
  s1.writeUInt32BE(timestamp, 0);
  s1.writeUInt32BE(0, 4);
  const random = crypto.randomBytes(1528);
  random.copy(s1, 8);

  // S2: echo of C1 with server timestamp at bytes 4-7 = 1536 bytes
  const s2 = Buffer.alloc(1536);
  c1.copy(s2);
  // Overwrite bytes 4-7 with server timestamp
  s2.writeUInt32BE(timestamp, 4);

  return Buffer.concat([s0, s1, s2]);
}
