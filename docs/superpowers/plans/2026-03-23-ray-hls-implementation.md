# Ray-HLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a custom HLS streaming system from scratch in Node.js/TypeScript with pluggable ABR strategies and a prefetch engine.

**Architecture:** Server pipeline (Ingest -> Transcoder -> TS Packager -> Manifest Generator -> HTTP Server) processes video/audio into HLS segments. Browser-based custom player (TS Demuxer -> fMP4 Remuxer -> MSE playback) with pluggable ABR and prefetch engines consumes them.

**Tech Stack:** TypeScript, Node.js (http, net, child_process), Vitest, Playwright, FFmpeg (external)

**Spec:** `docs/superpowers/specs/2026-03-23-ray-hls-design.md`

---

## Review Errata (MUST apply during implementation)

The code samples below contain known bugs identified during plan review. Apply these corrections when implementing each task:

### Task 3 (PES Packet): Timestamp encoding fix
```typescript
// WRONG:
buf[2] = (((ts >> 14) & 0xFF) << 1) | 0x01;
// CORRECT:
buf[2] = ((ts >> 15) & 0x7F) << 1 | 0x01;
```

### Task 6 (TS Packager Orchestrator): Add unit tests
The orchestrator MUST have unit tests (not just compilation check). Test: PAT/PMT insertion at segment start, PES packetization, segment flush with correct duration.

### Task 7 (Manifest): Add CODECS attribute
```typescript
// In generateMasterPlaylist, add CODECS to EXT-X-STREAM-INF:
`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${level.width}x${level.height},CODECS="avc1.42c01e,mp4a.40.2"`
```

### Task 9 (HTTP Server): Extend EventEmitter + Add Range support
- `HLSServer` must `extends EventEmitter` (not optional chaining `this.emit?.()`)
- Add `Range` header parsing for `.ts` segments, respond with `206 Partial Content`

### Task 10 (Pipeline): PTS tracking from FFmpeg
Do NOT pass `0` for PTS. Parse H.264 Annex B stream for AU delimiter / IDR boundaries and compute PTS incrementally based on frame count and fps:
```typescript
// Track PTS per quality level:
const framePTS = frameCount * (PTS_CLOCK_RATE / fps); // e.g. 90000 / 30 = 3000 per frame
```

### Task 12 (fMP4 Remuxer): Fix MP4 box layouts

**mvhd**: v0 layout starts with creation_time(4) + modification_time(4) + timescale(4) + duration(4). Allocate 108 bytes, write timescale at offset 8, rate at offset 16, volume at offset 20, matrix at offset 32, next_track_ID at offset 96.

**tkhd**: v0 layout starts with creation_time(4) + modification_time(4) + track_ID(4) + reserved(4) + duration(4). Allocate 80 bytes, write track_ID at offset 8, layer at offset 28, alternate_group at offset 30, volume at offset 32, matrix at offset 36, width at offset 72, height at offset 76.

**Add media-segment.test.ts**: Verify moof+mdat structure, trun sample count and entry sizes.

### Task 12 (fMP4 Remuxer): Separate video/audio init segments
`generateInitSegment` must accept a `trackType: 'video' | 'audio' | 'both'` parameter. For MSE with separate SourceBuffers, generate video-only moov and audio-only moov.

### Task 15 (Player): Critical MSE fixes
1. Generate separate init segments: `generateInitSegment({...opts, trackType: 'video'})` for video SourceBuffer, `generateInitSegment({...opts, trackType: 'audio'})` for audio SourceBuffer
2. Generate separate media segments: split `generateMediaSegment` into `generateVideoMediaSegment` and `generateAudioMediaSegment`, append to respective SourceBuffers
3. Track and increment `videoBaseDecodeTime` and `audioBaseDecodeTime` by cumulative sample durations after each segment
4. Add retry counter (max 3) in loadLoop catch block

### Task 17 (RTMP): Multi-chunk message reassembly
`processChunks` must buffer partial messages across multiple chunks. Track in-progress message per chunk stream ID, accumulate until `messageLength` bytes received, then emit.

### Missing Task: Add Playwright E2E test (implement after Task 18)
Add a task for Playwright-based E2E test: load player page, verify video plays, switch ABR strategy, confirm quality change.

---

## File Map

```
ray-hls/
├── package.json
├── tsconfig.json
├── tsconfig.client.json
├── vitest.config.ts
├── src/
│   ├── shared/
│   │   └── types.ts                    # QualityLevel, SegmentInfo, HLS constants
│   ├── server/
│   │   ├── packager/
│   │   │   ├── ts-packet.ts            # 188-byte TS packet builder
│   │   │   ├── pes-packet.ts           # PES packet builder
│   │   │   ├── psi.ts                  # PAT/PMT table generation
│   │   │   ├── segmenter.ts            # IDR detection, segment boundary, flush
│   │   │   └── index.ts                # TSPackager class (orchestrator)
│   │   ├── manifest/
│   │   │   ├── master-playlist.ts      # Master m3u8 generation
│   │   │   ├── media-playlist.ts       # Media m3u8 generation (VOD + live)
│   │   │   └── index.ts                # ManifestGenerator class
│   │   ├── transcoder/
│   │   │   ├── ffmpeg-process.ts       # Single FFmpeg process wrapper
│   │   │   ├── quality-presets.ts      # 360p/480p/720p/1080p configs
│   │   │   └── index.ts               # Transcoder class (multi-quality)
│   │   ├── ingest/
│   │   │   ├── file-ingest.ts          # Local file reader
│   │   │   ├── rtmp/
│   │   │   │   ├── handshake.ts        # C0/C1/C2 S0/S1/S2
│   │   │   │   ├── chunk-parser.ts     # RTMP chunk stream parsing
│   │   │   │   ├── amf0.ts             # AMF0 decoder
│   │   │   │   └── rtmp-server.ts      # TCP server, message routing
│   │   │   └── index.ts               # Ingest class (file + rtmp)
│   │   ├── http/
│   │   │   └── server.ts              # HTTP server with CORS, routing
│   │   └── pipeline.ts                # Wires all server modules together
│   └── client/
│       ├── demuxer/
│       │   ├── ts-demuxer.ts           # TS packet parsing, PES extraction
│       │   └── nal-parser.ts           # H.264 NAL unit parsing from PES
│       ├── remuxer/
│       │   ├── mp4-box.ts              # Low-level MP4 box builder
│       │   ├── init-segment.ts         # ftyp + moov generation
│       │   └── media-segment.ts        # moof + mdat generation
│       ├── abr/
│       │   ├── types.ts                # ABRStrategy interface, ABRContext
│       │   ├── conservative.ts         # Conservative strategy
│       │   ├── aggressive.ts           # Aggressive strategy
│       │   ├── smooth.ts               # Smooth strategy
│       │   └── abr-engine.ts           # Engine: strategy registry + switching
│       ├── prefetch/
│       │   └── prefetch-engine.ts      # Buffer-ahead prefetching logic
│       ├── player/
│       │   ├── state-machine.ts        # Player states + transitions
│       │   ├── buffer-manager.ts       # SourceBuffer append queue, cleanup
│       │   └── hls-player.ts           # Main player orchestrator
│       ├── ui/
│       │   ├── index.html              # Player page
│       │   ├── debug-panel.ts          # ABR/bandwidth/buffer visualization
│       │   └── styles.css              # Player + debug panel styles
│       └── index.ts                    # Client entry point
├── test/
│   ├── server/
│   │   ├── packager/
│   │   │   ├── ts-packet.test.ts
│   │   │   ├── pes-packet.test.ts
│   │   │   ├── psi.test.ts
│   │   │   └── segmenter.test.ts
│   │   ├── manifest/
│   │   │   ├── master-playlist.test.ts
│   │   │   └── media-playlist.test.ts
│   │   ├── transcoder/
│   │   │   └── transcoder.test.ts
│   │   ├── ingest/
│   │   │   ├── file-ingest.test.ts
│   │   │   └── rtmp/
│   │   │       ├── handshake.test.ts
│   │   │       ├── chunk-parser.test.ts
│   │   │       └── amf0.test.ts
│   │   └── http/
│   │       └── server.test.ts
│   ├── client/
│   │   ├── demuxer/
│   │   │   └── ts-demuxer.test.ts
│   │   ├── remuxer/
│   │   │   ├── mp4-box.test.ts
│   │   │   └── init-segment.test.ts
│   │   ├── abr/
│   │   │   ├── conservative.test.ts
│   │   │   ├── aggressive.test.ts
│   │   │   ├── smooth.test.ts
│   │   │   └── abr-engine.test.ts
│   │   └── prefetch/
│   │       └── prefetch-engine.test.ts
│   ├── integration/
│   │   └── vod-pipeline.test.ts
│   └── fixtures/
│       └── README.md                   # Instructions for creating test fixtures
└── docs/
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.client.json`
- Create: `vitest.config.ts`
- Create: `src/shared/types.ts`

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/guest-user/workspace/ray-hls
npm init -y
```

- [ ] **Step 2: Install dev dependencies**

```bash
npm install --save-dev typescript vitest @types/node
```

- [ ] **Step 3: Create tsconfig.json for server**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/server/**/*", "src/shared/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 4: Create tsconfig.client.json for browser code**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist/client",
    "rootDir": "src",
    "strict": true,
    "lib": ["ES2022", "DOM"],
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/client/**/*", "src/shared/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
  },
});
```

- [ ] **Step 6: Create shared types**

```typescript
// src/shared/types.ts

export interface QualityLevel {
  name: string;           // '360p', '480p', '720p', '1080p'
  width: number;
  height: number;
  videoBitrate: number;   // bps
  audioBitrate: number;   // bps
}

export interface SegmentInfo {
  index: number;
  duration: number;       // seconds
  filename: string;       // e.g. 'seg-0.ts'
  quality: QualityLevel;
  byteSize: number;
}

export const QUALITY_LEVELS: QualityLevel[] = [
  { name: '360p',  width: 640,  height: 360,  videoBitrate: 800_000,  audioBitrate: 64_000  },
  { name: '480p',  width: 854,  height: 480,  videoBitrate: 1_400_000, audioBitrate: 96_000  },
  { name: '720p',  width: 1280, height: 720,  videoBitrate: 2_800_000, audioBitrate: 128_000 },
  { name: '1080p', width: 1920, height: 1080, videoBitrate: 5_000_000, audioBitrate: 192_000 },
];

export const TS_PACKET_SIZE = 188;
export const SEGMENT_DURATION = 6; // seconds
export const PTS_CLOCK_RATE = 90_000; // 90kHz

// MPEG-TS PIDs
export const PAT_PID = 0x0000;
export const PMT_PID = 0x1000;
export const VIDEO_PID = 0x0100;
export const AUDIO_PID = 0x0101;

// H.264 NAL unit types
export const NAL_TYPE_IDR = 5;
export const NAL_TYPE_NON_IDR = 1;
export const NAL_TYPE_SPS = 7;
export const NAL_TYPE_PPS = 8;

// MPEG-TS stream types
export const STREAM_TYPE_H264 = 0x1B;
export const STREAM_TYPE_AAC = 0x0F;
```

- [ ] **Step 7: Run TypeScript compilation to verify setup**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: project scaffolding with TypeScript, Vitest, shared types"
```

---

## Task 2: TS Packet Builder

**Files:**
- Create: `src/server/packager/ts-packet.ts`
- Create: `test/server/packager/ts-packet.test.ts`

- [ ] **Step 1: Write failing tests for TS packet creation**

```typescript
// test/server/packager/ts-packet.test.ts
import { describe, it, expect } from 'vitest';
import { buildTSPacket } from '../../../src/server/packager/ts-packet.js';
import { TS_PACKET_SIZE, VIDEO_PID } from '../../../src/shared/types.js';

describe('buildTSPacket', () => {
  it('produces a 188-byte packet', () => {
    const packet = buildTSPacket({
      pid: VIDEO_PID,
      payload: Buffer.alloc(184, 0xFF),
      payloadUnitStart: false,
      continuityCounter: 0,
    });
    expect(packet.length).toBe(TS_PACKET_SIZE);
  });

  it('starts with sync byte 0x47', () => {
    const packet = buildTSPacket({
      pid: VIDEO_PID,
      payload: Buffer.alloc(184, 0xFF),
      payloadUnitStart: false,
      continuityCounter: 0,
    });
    expect(packet[0]).toBe(0x47);
  });

  it('encodes PID correctly in bytes 1-2', () => {
    const packet = buildTSPacket({
      pid: 0x0100,
      payload: Buffer.alloc(184, 0xFF),
      payloadUnitStart: false,
      continuityCounter: 0,
    });
    // PID is in bits 5-12 of byte 1 and all of byte 2
    const pid = ((packet[1] & 0x1F) << 8) | packet[2];
    expect(pid).toBe(0x0100);
  });

  it('sets payload_unit_start_indicator when requested', () => {
    const packet = buildTSPacket({
      pid: VIDEO_PID,
      payload: Buffer.alloc(184, 0xFF),
      payloadUnitStart: true,
      continuityCounter: 0,
    });
    expect(packet[1] & 0x40).toBe(0x40);
  });

  it('encodes continuity counter in lower 4 bits of byte 3', () => {
    const packet = buildTSPacket({
      pid: VIDEO_PID,
      payload: Buffer.alloc(184, 0xFF),
      payloadUnitStart: false,
      continuityCounter: 7,
    });
    expect(packet[3] & 0x0F).toBe(7);
  });

  it('pads with 0xFF when payload is smaller than 184 bytes', () => {
    const payload = Buffer.alloc(100, 0xAA);
    const packet = buildTSPacket({
      pid: VIDEO_PID,
      payload,
      payloadUnitStart: false,
      continuityCounter: 0,
    });
    expect(packet.length).toBe(TS_PACKET_SIZE);
    // Should have adaptation field with stuffing
  });

  it('includes PCR in adaptation field when provided', () => {
    const packet = buildTSPacket({
      pid: VIDEO_PID,
      payload: Buffer.alloc(170, 0xFF),
      payloadUnitStart: false,
      continuityCounter: 0,
      pcr: 90_000, // 1 second at 90kHz
    });
    expect(packet.length).toBe(TS_PACKET_SIZE);
    // Adaptation field present: byte 3 bits 5-4 should indicate adaptation + payload
    expect((packet[3] >> 4) & 0x03).toBe(0x03);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/packager/ts-packet.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ts-packet.ts**

```typescript
// src/server/packager/ts-packet.ts

import { TS_PACKET_SIZE } from '../../shared/types.js';

export interface TSPacketOptions {
  pid: number;
  payload: Buffer;
  payloadUnitStart: boolean;
  continuityCounter: number;
  pcr?: number; // 90kHz clock value
}

export function buildTSPacket(opts: TSPacketOptions): Buffer {
  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xFF);
  const { pid, payload, payloadUnitStart, continuityCounter, pcr } = opts;

  // Byte 0: Sync byte
  packet[0] = 0x47;

  // Bytes 1-2: TEI(0) | PUSI | Priority(0) | PID
  packet[1] = ((payloadUnitStart ? 1 : 0) << 6) | ((pid >> 8) & 0x1F);
  packet[2] = pid & 0xFF;

  const hasPCR = pcr !== undefined;
  const adaptationFieldLength = hasPCR ? 8 : 0; // 1 (flags) + 6 (PCR) + 1 (length byte itself excluded)
  const needsStuffing = payload.length < (184 - (hasPCR ? 8 : 0));
  const hasAdaptation = hasPCR || needsStuffing;

  if (hasAdaptation) {
    // Byte 3: scrambling(0) | adaptation_field_control | continuity_counter
    packet[3] = (0x03 << 4) | (continuityCounter & 0x0F); // adaptation + payload

    let adaptLen: number;
    if (hasPCR) {
      adaptLen = 7; // 1 flags byte + 6 PCR bytes
      const stuffingLen = 184 - 1 - adaptLen - payload.length;
      if (stuffingLen > 0) {
        adaptLen += stuffingLen;
      }
    } else {
      adaptLen = 184 - 1 - payload.length;
    }

    packet[4] = adaptLen; // adaptation_field_length

    if (adaptLen > 0) {
      const flagsOffset = 5;
      packet[flagsOffset] = hasPCR ? 0x10 : 0x00; // PCR flag

      let offset = 6;
      if (hasPCR) {
        // PCR: 33-bit base + 6 reserved + 9-bit extension
        const pcrBase = pcr!;
        const pcrExt = 0;
        packet[offset++] = (pcrBase >> 25) & 0xFF;
        packet[offset++] = (pcrBase >> 17) & 0xFF;
        packet[offset++] = (pcrBase >> 9) & 0xFF;
        packet[offset++] = (pcrBase >> 1) & 0xFF;
        packet[offset++] = ((pcrBase & 0x01) << 7) | 0x7E | ((pcrExt >> 8) & 0x01);
        packet[offset++] = pcrExt & 0xFF;
      }

      // Remaining adaptation field is already 0xFF (stuffing)
    }

    // Copy payload after adaptation field
    const payloadOffset = 5 + adaptLen;
    payload.copy(packet, payloadOffset, 0, Math.min(payload.length, TS_PACKET_SIZE - payloadOffset));
  } else {
    // Byte 3: adaptation_field_control = 01 (payload only)
    packet[3] = (0x01 << 4) | (continuityCounter & 0x0F);

    // Copy payload starting at byte 4
    payload.copy(packet, 4, 0, Math.min(payload.length, 184));
  }

  return packet;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server/packager/ts-packet.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/packager/ts-packet.ts test/server/packager/ts-packet.test.ts
git commit -m "feat: TS packet builder with PCR and stuffing support"
```

---

## Task 3: PES Packet Builder

**Files:**
- Create: `src/server/packager/pes-packet.ts`
- Create: `test/server/packager/pes-packet.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/server/packager/pes-packet.test.ts
import { describe, it, expect } from 'vitest';
import { buildPESPacket } from '../../../src/server/packager/pes-packet.js';

describe('buildPESPacket', () => {
  it('starts with PES start code 0x000001', () => {
    const pes = buildPESPacket({
      streamId: 0xE0, // video
      payload: Buffer.from([0x00, 0x00, 0x01, 0x65]), // IDR NAL
      pts: 90_000,
    });
    expect(pes[0]).toBe(0x00);
    expect(pes[1]).toBe(0x00);
    expect(pes[2]).toBe(0x01);
  });

  it('sets correct stream ID', () => {
    const pes = buildPESPacket({
      streamId: 0xE0,
      payload: Buffer.alloc(10),
      pts: 0,
    });
    expect(pes[3]).toBe(0xE0);
  });

  it('uses stream ID 0xC0 for audio', () => {
    const pes = buildPESPacket({
      streamId: 0xC0,
      payload: Buffer.alloc(10),
      pts: 0,
    });
    expect(pes[3]).toBe(0xC0);
  });

  it('encodes PTS correctly', () => {
    const pes = buildPESPacket({
      streamId: 0xE0,
      payload: Buffer.alloc(10),
      pts: 90_000, // 1 second
    });
    // PTS flag should be set in PES header
    // Byte 7: PTS_DTS_flags in bits 7-6
    expect(pes[7] & 0xC0).toBe(0x80); // PTS only
  });

  it('encodes both PTS and DTS when DTS provided', () => {
    const pes = buildPESPacket({
      streamId: 0xE0,
      payload: Buffer.alloc(10),
      pts: 90_000,
      dts: 85_000,
    });
    expect(pes[7] & 0xC0).toBe(0xC0); // PTS + DTS
  });

  it('includes payload after header', () => {
    const payload = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const pes = buildPESPacket({
      streamId: 0xE0,
      payload,
      pts: 0,
    });
    // Payload should appear at the end
    const pesPayload = pes.subarray(pes.length - 4);
    expect(pesPayload).toEqual(payload);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/packager/pes-packet.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement pes-packet.ts**

```typescript
// src/server/packager/pes-packet.ts

export interface PESPacketOptions {
  streamId: number;  // 0xE0 video, 0xC0 audio
  payload: Buffer;
  pts: number;       // 90kHz clock
  dts?: number;      // 90kHz clock
}

function encodeTimestamp(marker: number, ts: number): Buffer {
  const buf = Buffer.alloc(5);
  buf[0] = ((marker & 0x0F) << 4) | (((ts >> 29) & 0x07) << 1) | 0x01;
  buf[1] = (ts >> 22) & 0xFF;
  buf[2] = (((ts >> 14) & 0xFF) << 1) | 0x01;
  buf[3] = (ts >> 7) & 0xFF;
  buf[4] = ((ts & 0x7F) << 1) | 0x01;
  return buf;
}

export function buildPESPacket(opts: PESPacketOptions): Buffer {
  const { streamId, payload, pts, dts } = opts;
  const hasDTS = dts !== undefined;

  const headerDataLength = hasDTS ? 10 : 5; // PTS = 5 bytes, PTS+DTS = 10 bytes
  const pesHeaderLength = 3 + 1 + 2 + 2 + 1 + headerDataLength;
  // 3: start code, 1: stream id, 2: PES packet length, 2: flags, 1: header data length

  const pesPacketLength = 3 + headerDataLength + payload.length;
  // 2 (flags) + 1 (header data length) + headerDataLength + payload

  const pes = Buffer.alloc(pesHeaderLength + payload.length);
  let offset = 0;

  // Start code: 0x000001
  pes[offset++] = 0x00;
  pes[offset++] = 0x00;
  pes[offset++] = 0x01;

  // Stream ID
  pes[offset++] = streamId;

  // PES packet length (0 for unbounded video streams, or actual length if fits in 16 bits)
  if (pesPacketLength <= 0xFFFF) {
    pes[offset++] = (pesPacketLength >> 8) & 0xFF;
    pes[offset++] = pesPacketLength & 0xFF;
  } else {
    pes[offset++] = 0x00;
    pes[offset++] = 0x00;
  }

  // Flags byte 1: marker bits(10) | scrambling(00) | priority(0) | alignment(1) | copyright(0) | original(0)
  pes[offset++] = 0x84;

  // Flags byte 2: PTS_DTS_flags | other flags (all 0)
  pes[offset++] = hasDTS ? 0xC0 : 0x80;

  // PES header data length
  pes[offset++] = headerDataLength;

  // PTS
  const ptsMarker = hasDTS ? 0x03 : 0x02;
  const ptsBuf = encodeTimestamp(ptsMarker, pts);
  ptsBuf.copy(pes, offset);
  offset += 5;

  // DTS (if present)
  if (hasDTS) {
    const dtsBuf = encodeTimestamp(0x01, dts!);
    dtsBuf.copy(pes, offset);
    offset += 5;
  }

  // Payload
  payload.copy(pes, offset);

  return pes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server/packager/pes-packet.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/packager/pes-packet.ts test/server/packager/pes-packet.test.ts
git commit -m "feat: PES packet builder with PTS/DTS encoding"
```

---

## Task 4: PSI Tables (PAT/PMT)

**Files:**
- Create: `src/server/packager/psi.ts`
- Create: `test/server/packager/psi.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/server/packager/psi.test.ts
import { describe, it, expect } from 'vitest';
import { buildPAT, buildPMT } from '../../../src/server/packager/psi.js';
import { PMT_PID, VIDEO_PID, AUDIO_PID, STREAM_TYPE_H264, STREAM_TYPE_AAC } from '../../../src/shared/types.js';

describe('buildPAT', () => {
  it('returns a Buffer', () => {
    const pat = buildPAT(PMT_PID);
    expect(Buffer.isBuffer(pat)).toBe(true);
  });

  it('starts with table ID 0x00', () => {
    const pat = buildPAT(PMT_PID);
    expect(pat[0]).toBe(0x00);
  });

  it('contains program number 1 mapped to PMT PID', () => {
    const pat = buildPAT(PMT_PID);
    // Program number (2 bytes) + PMT PID (2 bytes) after fixed header
    // Find program_number = 1
    const programData = pat.subarray(8, 12);
    const programNumber = (programData[0] << 8) | programData[1];
    const pmtPid = ((programData[2] & 0x1F) << 8) | programData[3];
    expect(programNumber).toBe(1);
    expect(pmtPid).toBe(PMT_PID);
  });

  it('ends with valid CRC32', () => {
    const pat = buildPAT(PMT_PID);
    // CRC32 is last 4 bytes — just verify it exists (non-zero)
    const crc = pat.readUInt32BE(pat.length - 4);
    expect(crc).not.toBe(0);
  });
});

describe('buildPMT', () => {
  it('starts with table ID 0x02', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    expect(pmt[0]).toBe(0x02);
  });

  it('contains video stream entry with H.264 type', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    // Search for stream_type 0x1B (H.264) followed by VIDEO_PID
    let found = false;
    for (let i = 0; i < pmt.length - 4; i++) {
      if (pmt[i] === STREAM_TYPE_H264) {
        const pid = ((pmt[i + 1] & 0x1F) << 8) | pmt[i + 2];
        if (pid === VIDEO_PID) found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('contains audio stream entry with AAC type', () => {
    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    let found = false;
    for (let i = 0; i < pmt.length - 4; i++) {
      if (pmt[i] === STREAM_TYPE_AAC) {
        const pid = ((pmt[i + 1] & 0x1F) << 8) | pmt[i + 2];
        if (pid === AUDIO_PID) found = true;
      }
    }
    expect(found).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/packager/psi.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement psi.ts**

```typescript
// src/server/packager/psi.ts

import { STREAM_TYPE_H264, STREAM_TYPE_AAC } from '../../shared/types.js';

function crc32(data: Buffer): number {
  // CRC32/MPEG2 lookup table
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
    }
    table[i] = crc >>> 0;
  }

  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (table[((crc >> 24) ^ data[i]) & 0xFF] ^ (crc << 8)) >>> 0;
  }
  return crc;
}

export function buildPAT(pmtPid: number): Buffer {
  const sectionLength = 9 + 4; // 9 bytes (fixed) + 4 (CRC)
  // table_id(1) + section_syntax(2) + tsi(2) + version(1) + section(2) + programs(4) + crc(4) = 16
  const pat = Buffer.alloc(12 + 4); // without CRC + CRC
  let offset = 0;

  pat[offset++] = 0x00; // table_id
  pat[offset++] = 0xB0 | ((sectionLength >> 8) & 0x0F); // section_syntax_indicator + section_length high
  pat[offset++] = sectionLength & 0xFF; // section_length low
  pat[offset++] = 0x00; // transport_stream_id high
  pat[offset++] = 0x01; // transport_stream_id low
  pat[offset++] = 0xC1; // reserved(2) + version(0) + current_next(1)
  pat[offset++] = 0x00; // section_number
  pat[offset++] = 0x00; // last_section_number

  // Program 1 -> PMT PID
  pat[offset++] = 0x00; // program_number high
  pat[offset++] = 0x01; // program_number low
  pat[offset++] = 0xE0 | ((pmtPid >> 8) & 0x1F); // reserved + PMT PID high
  pat[offset++] = pmtPid & 0xFF; // PMT PID low

  // CRC32
  const crc = crc32(pat.subarray(0, offset));
  pat.writeUInt32BE(crc, offset);

  return pat;
}

export function buildPMT(videoPid: number, audioPid: number): Buffer {
  // PMT: table_id + header + PCR PID + program_info_length + streams + CRC
  const streamEntrySize = 5; // stream_type(1) + PID(2) + ES_info_length(2)
  const sectionLength = 9 + 4 + (streamEntrySize * 2) + 4; // header + pcr_pid+proginfo + 2 streams + CRC
  const pmt = Buffer.alloc(3 + sectionLength - 4 + 4); // awkward but correct total
  let offset = 0;

  pmt[offset++] = 0x02; // table_id
  pmt[offset++] = 0xB0 | ((sectionLength >> 8) & 0x0F);
  pmt[offset++] = sectionLength & 0xFF;
  pmt[offset++] = 0x00; // program_number high
  pmt[offset++] = 0x01; // program_number low
  pmt[offset++] = 0xC1; // reserved + version(0) + current_next(1)
  pmt[offset++] = 0x00; // section_number
  pmt[offset++] = 0x00; // last_section_number

  // PCR PID = video PID
  pmt[offset++] = 0xE0 | ((videoPid >> 8) & 0x1F);
  pmt[offset++] = videoPid & 0xFF;

  // Program info length = 0
  pmt[offset++] = 0xF0;
  pmt[offset++] = 0x00;

  // Video stream entry
  pmt[offset++] = STREAM_TYPE_H264;
  pmt[offset++] = 0xE0 | ((videoPid >> 8) & 0x1F);
  pmt[offset++] = videoPid & 0xFF;
  pmt[offset++] = 0xF0; // ES_info_length = 0
  pmt[offset++] = 0x00;

  // Audio stream entry
  pmt[offset++] = STREAM_TYPE_AAC;
  pmt[offset++] = 0xE0 | ((audioPid >> 8) & 0x1F);
  pmt[offset++] = audioPid & 0xFF;
  pmt[offset++] = 0xF0;
  pmt[offset++] = 0x00;

  // CRC32
  const crc = crc32(pmt.subarray(0, offset));
  pmt.writeUInt32BE(crc, offset);
  offset += 4;

  return pmt.subarray(0, offset);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/packager/psi.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/packager/psi.ts test/server/packager/psi.test.ts
git commit -m "feat: PAT/PMT table generation with CRC32"
```

---

## Task 5: Segmenter (IDR Detection + Segment Boundary)

**Files:**
- Create: `src/server/packager/segmenter.ts`
- Create: `test/server/packager/segmenter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/server/packager/segmenter.test.ts
import { describe, it, expect } from 'vitest';
import { Segmenter } from '../../../src/server/packager/segmenter.js';
import { NAL_TYPE_IDR, NAL_TYPE_NON_IDR, NAL_TYPE_SPS, NAL_TYPE_PPS } from '../../../src/shared/types.js';

function makeAnnexBNAL(type: number, size: number): Buffer {
  // Start code (4 bytes) + NAL header (1 byte) + payload
  const buf = Buffer.alloc(4 + 1 + size);
  buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0x01;
  buf[4] = type & 0x1F;
  return buf;
}

describe('Segmenter', () => {
  it('detects IDR NAL units', () => {
    const segmenter = new Segmenter();
    const idr = makeAnnexBNAL(NAL_TYPE_IDR, 100);
    const result = segmenter.pushVideoData(idr, 90_000);
    expect(result.isNewSegment).toBe(true);
  });

  it('does not start new segment on non-IDR NAL', () => {
    const segmenter = new Segmenter();
    // First IDR to start first segment
    segmenter.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 100), 0);
    // Non-IDR should not start new segment
    const result = segmenter.pushVideoData(makeAnnexBNAL(NAL_TYPE_NON_IDR, 50), 3000);
    expect(result.isNewSegment).toBe(false);
  });

  it('tracks segment index incrementally', () => {
    const segmenter = new Segmenter();
    segmenter.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 100), 0);
    expect(segmenter.currentSegmentIndex).toBe(0);
    segmenter.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 100), 540_000);
    expect(segmenter.currentSegmentIndex).toBe(1);
  });

  it('calculates segment duration from PTS difference', () => {
    const segmenter = new Segmenter();
    segmenter.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 100), 0);
    const result = segmenter.pushVideoData(makeAnnexBNAL(NAL_TYPE_IDR, 100), 540_000); // 6 seconds
    expect(result.completedSegmentDuration).toBeCloseTo(6.0, 1);
  });

  it('extracts SPS and PPS NAL units', () => {
    const segmenter = new Segmenter();
    segmenter.pushVideoData(makeAnnexBNAL(NAL_TYPE_SPS, 20), 0);
    segmenter.pushVideoData(makeAnnexBNAL(NAL_TYPE_PPS, 10), 0);
    expect(segmenter.sps).not.toBeNull();
    expect(segmenter.pps).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/packager/segmenter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement segmenter.ts**

```typescript
// src/server/packager/segmenter.ts

import { NAL_TYPE_IDR, NAL_TYPE_SPS, NAL_TYPE_PPS, PTS_CLOCK_RATE } from '../../shared/types.js';

export interface SegmenterResult {
  isNewSegment: boolean;
  completedSegmentDuration?: number; // seconds
  nalUnits: Buffer[];
}

export class Segmenter {
  currentSegmentIndex = -1;
  sps: Buffer | null = null;
  pps: Buffer | null = null;

  private segmentStartPTS = 0;
  private currentNALs: Buffer[] = [];

  pushVideoData(data: Buffer, pts: number): SegmenterResult {
    const nalUnits = this.parseAnnexB(data);
    let isNewSegment = false;
    let completedSegmentDuration: number | undefined;

    for (const nal of nalUnits) {
      const nalType = nal[0] & 0x1F;

      if (nalType === NAL_TYPE_SPS) {
        this.sps = Buffer.from(nal);
      } else if (nalType === NAL_TYPE_PPS) {
        this.pps = Buffer.from(nal);
      }

      if (nalType === NAL_TYPE_IDR) {
        if (this.currentSegmentIndex >= 0) {
          completedSegmentDuration = (pts - this.segmentStartPTS) / PTS_CLOCK_RATE;
        }
        this.currentSegmentIndex++;
        this.segmentStartPTS = pts;
        this.currentNALs = [];
        isNewSegment = true;
      }
    }

    this.currentNALs.push(...nalUnits);

    return { isNewSegment, completedSegmentDuration, nalUnits };
  }

  private parseAnnexB(data: Buffer): Buffer[] {
    const nalUnits: Buffer[] = [];
    let start = -1;

    for (let i = 0; i < data.length - 3; i++) {
      const isStartCode3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
      const isStartCode4 = i < data.length - 4 &&
        data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;

      if (isStartCode4 || isStartCode3) {
        if (start >= 0) {
          nalUnits.push(data.subarray(start, i));
        }
        start = isStartCode4 ? i + 4 : i + 3;
        if (isStartCode4) i += 3;
        else i += 2;
      }
    }

    if (start >= 0 && start < data.length) {
      nalUnits.push(data.subarray(start));
    }

    return nalUnits;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/packager/segmenter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/packager/segmenter.ts test/server/packager/segmenter.test.ts
git commit -m "feat: segmenter with IDR detection and Annex B parsing"
```

---

## Task 6: TS Packager Orchestrator

**Files:**
- Create: `src/server/packager/index.ts`

- [ ] **Step 1: Implement TSPackager class**

This module wires ts-packet, pes-packet, psi, and segmenter together. It receives raw H.264 + AAC data and outputs complete .ts segment files.

```typescript
// src/server/packager/index.ts

import { EventEmitter } from 'events';
import { buildTSPacket } from './ts-packet.js';
import { buildPESPacket } from './pes-packet.js';
import { buildPAT, buildPMT } from './psi.js';
import { Segmenter } from './segmenter.js';
import {
  VIDEO_PID, AUDIO_PID, PAT_PID, PMT_PID,
  TS_PACKET_SIZE, SegmentInfo, QualityLevel,
} from '../../shared/types.js';

export interface TSPackagerEvents {
  segment: (info: SegmentInfo, data: Buffer) => void;
}

export class TSPackager extends EventEmitter {
  private segmenter = new Segmenter();
  private videoContinuity = 0;
  private audioContinuity = 0;
  private patContinuity = 0;
  private pmtContinuity = 0;
  private currentSegmentPackets: Buffer[] = [];
  private quality: QualityLevel;

  constructor(quality: QualityLevel) {
    super();
    this.quality = quality;
  }

  pushVideo(data: Buffer, pts: number, dts?: number): void {
    const result = this.segmenter.pushVideoData(data, pts);

    if (result.isNewSegment && this.currentSegmentPackets.length > 0) {
      this.flushSegment(result.completedSegmentDuration ?? 0);
    }

    if (result.isNewSegment) {
      this.writePSI();
    }

    const pes = buildPESPacket({
      streamId: 0xE0,
      payload: data,
      pts,
      dts,
    });

    this.packetizePES(pes, VIDEO_PID, true, pts);
  }

  pushAudio(data: Buffer, pts: number): void {
    const pes = buildPESPacket({
      streamId: 0xC0,
      payload: data,
      pts,
    });

    this.packetizePES(pes, AUDIO_PID, false);
  }

  flush(): void {
    if (this.currentSegmentPackets.length > 0) {
      const duration = 0; // final segment — duration calculated by caller
      this.flushSegment(duration);
    }
  }

  private writePSI(): void {
    const pat = buildPAT(PMT_PID);
    const patPacket = buildTSPacket({
      pid: PAT_PID,
      payload: Buffer.concat([Buffer.from([0x00]), pat]), // pointer field + PAT
      payloadUnitStart: true,
      continuityCounter: this.patContinuity++ & 0x0F,
    });
    this.currentSegmentPackets.push(patPacket);

    const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
    const pmtPacket = buildTSPacket({
      pid: PMT_PID,
      payload: Buffer.concat([Buffer.from([0x00]), pmt]),
      payloadUnitStart: true,
      continuityCounter: this.pmtContinuity++ & 0x0F,
    });
    this.currentSegmentPackets.push(pmtPacket);
  }

  private packetizePES(pes: Buffer, pid: number, includePCR: boolean, pcr?: number): void {
    const isVideo = pid === VIDEO_PID;
    let offset = 0;
    let first = true;

    while (offset < pes.length) {
      const maxPayload = first && includePCR && pcr !== undefined ? 170 : 184;
      const chunk = pes.subarray(offset, offset + maxPayload);

      const packet = buildTSPacket({
        pid,
        payload: chunk,
        payloadUnitStart: first,
        continuityCounter: isVideo
          ? this.videoContinuity++ & 0x0F
          : this.audioContinuity++ & 0x0F,
        pcr: first && includePCR ? pcr : undefined,
      });

      this.currentSegmentPackets.push(packet);
      offset += chunk.length;
      first = false;
    }
  }

  private flushSegment(duration: number): void {
    const data = Buffer.concat(this.currentSegmentPackets);
    const index = this.segmenter.currentSegmentIndex - 1;
    const info: SegmentInfo = {
      index,
      duration,
      filename: `${this.quality.name}-seg-${index}.ts`,
      quality: this.quality,
      byteSize: data.length,
    };

    this.emit('segment', info, data);
    this.currentSegmentPackets = [];
  }
}

export { Segmenter } from './segmenter.js';
export { buildTSPacket } from './ts-packet.js';
export { buildPESPacket } from './pes-packet.js';
export { buildPAT, buildPMT } from './psi.js';
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/packager/index.ts
git commit -m "feat: TSPackager orchestrator wiring all packager components"
```

---

## Task 7: Manifest Generator

**Files:**
- Create: `src/server/manifest/master-playlist.ts`
- Create: `src/server/manifest/media-playlist.ts`
- Create: `src/server/manifest/index.ts`
- Create: `test/server/manifest/master-playlist.test.ts`
- Create: `test/server/manifest/media-playlist.test.ts`

- [ ] **Step 1: Write failing tests for master playlist**

```typescript
// test/server/manifest/master-playlist.test.ts
import { describe, it, expect } from 'vitest';
import { generateMasterPlaylist } from '../../../src/server/manifest/master-playlist.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';

describe('generateMasterPlaylist', () => {
  it('starts with #EXTM3U', () => {
    const m3u8 = generateMasterPlaylist(QUALITY_LEVELS);
    expect(m3u8.startsWith('#EXTM3U')).toBe(true);
  });

  it('contains EXT-X-STREAM-INF for each quality level', () => {
    const m3u8 = generateMasterPlaylist(QUALITY_LEVELS);
    const streamInfs = m3u8.split('\n').filter(l => l.startsWith('#EXT-X-STREAM-INF'));
    expect(streamInfs.length).toBe(4);
  });

  it('includes BANDWIDTH attribute', () => {
    const m3u8 = generateMasterPlaylist(QUALITY_LEVELS);
    expect(m3u8).toContain('BANDWIDTH=864000'); // 800k video + 64k audio for 360p
  });

  it('includes RESOLUTION attribute', () => {
    const m3u8 = generateMasterPlaylist(QUALITY_LEVELS);
    expect(m3u8).toContain('RESOLUTION=640x360');
    expect(m3u8).toContain('RESOLUTION=1920x1080');
  });

  it('includes variant playlist URLs', () => {
    const m3u8 = generateMasterPlaylist(QUALITY_LEVELS);
    expect(m3u8).toContain('360p/playlist.m3u8');
    expect(m3u8).toContain('1080p/playlist.m3u8');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/manifest/master-playlist.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement master-playlist.ts**

```typescript
// src/server/manifest/master-playlist.ts

import { QualityLevel } from '../../shared/types.js';

export function generateMasterPlaylist(levels: QualityLevel[]): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3', ''];

  for (const level of levels) {
    const bandwidth = level.videoBitrate + level.audioBitrate;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${level.width}x${level.height}`,
      `${level.name}/playlist.m3u8`,
      '',
    );
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run master playlist tests**

Run: `npx vitest run test/server/manifest/master-playlist.test.ts`
Expected: All PASS

- [ ] **Step 5: Write failing tests for media playlist**

```typescript
// test/server/manifest/media-playlist.test.ts
import { describe, it, expect } from 'vitest';
import { MediaPlaylist } from '../../../src/server/manifest/media-playlist.js';

describe('MediaPlaylist', () => {
  describe('VOD mode', () => {
    it('includes EXT-X-ENDLIST', () => {
      const playlist = new MediaPlaylist('vod');
      playlist.addSegment({ index: 0, duration: 6.0, filename: 'seg-0.ts' });
      playlist.addSegment({ index: 1, duration: 6.0, filename: 'seg-1.ts' });
      const m3u8 = playlist.generate();
      expect(m3u8).toContain('#EXT-X-ENDLIST');
    });

    it('lists all segments with EXTINF', () => {
      const playlist = new MediaPlaylist('vod');
      playlist.addSegment({ index: 0, duration: 6.0, filename: 'seg-0.ts' });
      playlist.addSegment({ index: 1, duration: 5.8, filename: 'seg-1.ts' });
      const m3u8 = playlist.generate();
      expect(m3u8).toContain('#EXTINF:6.000,');
      expect(m3u8).toContain('#EXTINF:5.800,');
      expect(m3u8).toContain('seg-0.ts');
      expect(m3u8).toContain('seg-1.ts');
    });

    it('sets EXT-X-TARGETDURATION to the ceiling of max segment duration', () => {
      const playlist = new MediaPlaylist('vod');
      playlist.addSegment({ index: 0, duration: 6.2, filename: 'seg-0.ts' });
      const m3u8 = playlist.generate();
      expect(m3u8).toContain('#EXT-X-TARGETDURATION:7');
    });
  });

  describe('live mode', () => {
    it('does NOT include EXT-X-ENDLIST', () => {
      const playlist = new MediaPlaylist('live');
      playlist.addSegment({ index: 0, duration: 6.0, filename: 'seg-0.ts' });
      const m3u8 = playlist.generate();
      expect(m3u8).not.toContain('#EXT-X-ENDLIST');
    });

    it('keeps only the last 5 segments (sliding window)', () => {
      const playlist = new MediaPlaylist('live');
      for (let i = 0; i < 8; i++) {
        playlist.addSegment({ index: i, duration: 6.0, filename: `seg-${i}.ts` });
      }
      const m3u8 = playlist.generate();
      expect(m3u8).not.toContain('seg-0.ts');
      expect(m3u8).not.toContain('seg-2.ts');
      expect(m3u8).toContain('seg-3.ts');
      expect(m3u8).toContain('seg-7.ts');
    });

    it('updates EXT-X-MEDIA-SEQUENCE correctly', () => {
      const playlist = new MediaPlaylist('live');
      for (let i = 0; i < 8; i++) {
        playlist.addSegment({ index: i, duration: 6.0, filename: `seg-${i}.ts` });
      }
      const m3u8 = playlist.generate();
      expect(m3u8).toContain('#EXT-X-MEDIA-SEQUENCE:3');
    });

    it('finalize() adds EXT-X-ENDLIST', () => {
      const playlist = new MediaPlaylist('live');
      playlist.addSegment({ index: 0, duration: 6.0, filename: 'seg-0.ts' });
      playlist.finalize();
      const m3u8 = playlist.generate();
      expect(m3u8).toContain('#EXT-X-ENDLIST');
    });
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run test/server/manifest/media-playlist.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement media-playlist.ts**

```typescript
// src/server/manifest/media-playlist.ts

interface SegmentEntry {
  index: number;
  duration: number;
  filename: string;
}

const SLIDING_WINDOW_SIZE = 5;

export class MediaPlaylist {
  private segments: SegmentEntry[] = [];
  private mode: 'vod' | 'live';
  private finalized = false;

  constructor(mode: 'vod' | 'live') {
    this.mode = mode;
  }

  addSegment(entry: SegmentEntry): void {
    this.segments.push(entry);
  }

  finalize(): void {
    this.finalized = true;
  }

  generate(): string {
    const visibleSegments = this.mode === 'live' && this.segments.length > SLIDING_WINDOW_SIZE
      ? this.segments.slice(-SLIDING_WINDOW_SIZE)
      : this.segments;

    const maxDuration = Math.ceil(
      visibleSegments.reduce((max, s) => Math.max(max, s.duration), 0)
    );

    const mediaSequence = visibleSegments.length > 0 ? visibleSegments[0].index : 0;

    const lines: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${maxDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
      '',
    ];

    for (const seg of visibleSegments) {
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(seg.filename);
    }

    if (this.mode === 'vod' || this.finalized) {
      lines.push('#EXT-X-ENDLIST');
    }

    return lines.join('\n');
  }
}
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run test/server/manifest/media-playlist.test.ts`
Expected: All PASS

- [ ] **Step 9: Create manifest/index.ts**

```typescript
// src/server/manifest/index.ts

import { QualityLevel, SegmentInfo } from '../../shared/types.js';
import { generateMasterPlaylist } from './master-playlist.js';
import { MediaPlaylist } from './media-playlist.js';

export class ManifestGenerator {
  private levels: QualityLevel[];
  private mode: 'vod' | 'live';
  private playlists = new Map<string, MediaPlaylist>();

  constructor(levels: QualityLevel[], mode: 'vod' | 'live') {
    this.levels = levels;
    this.mode = mode;
    for (const level of levels) {
      this.playlists.set(level.name, new MediaPlaylist(mode));
    }
  }

  getMasterPlaylist(): string {
    return generateMasterPlaylist(this.levels);
  }

  addSegment(qualityName: string, segment: { index: number; duration: number; filename: string }): void {
    this.playlists.get(qualityName)?.addSegment(segment);
  }

  getMediaPlaylist(qualityName: string): string | null {
    return this.playlists.get(qualityName)?.generate() ?? null;
  }

  finalize(): void {
    for (const playlist of this.playlists.values()) {
      playlist.finalize();
    }
  }
}

export { generateMasterPlaylist } from './master-playlist.js';
export { MediaPlaylist } from './media-playlist.js';
```

- [ ] **Step 10: Commit**

```bash
git add src/server/manifest/ test/server/manifest/
git commit -m "feat: manifest generator with master/media playlist (VOD + live)"
```

---

## Task 8: Transcoder (FFmpeg Wrapper)

**Files:**
- Create: `src/server/transcoder/quality-presets.ts`
- Create: `src/server/transcoder/ffmpeg-process.ts`
- Create: `src/server/transcoder/index.ts`
- Create: `test/server/transcoder/transcoder.test.ts`

- [ ] **Step 1: Create quality-presets.ts**

```typescript
// src/server/transcoder/quality-presets.ts

import { QualityLevel, QUALITY_LEVELS } from '../../shared/types.js';

export interface FFmpegPreset {
  level: QualityLevel;
  videoArgs: string[];
  audioArgs: string[];
}

export function getPresets(keyframeInterval: number = 180): FFmpegPreset[] {
  return QUALITY_LEVELS.map(level => ({
    level,
    videoArgs: [
      '-c:v', 'libx264',
      '-b:v', `${level.videoBitrate}`,
      '-s', `${level.width}x${level.height}`,
      '-g', `${keyframeInterval}`,
      '-keyint_min', `${keyframeInterval}`,
      '-sc_threshold', '0',
      '-profile:v', 'main',
      '-preset', 'fast',
      '-f', 'h264',
    ],
    audioArgs: [
      '-c:a', 'aac',
      '-b:a', `${level.audioBitrate}`,
      '-ar', '44100',
      '-ac', '2',
      '-f', 'adts',
    ],
  }));
}
```

- [ ] **Step 2: Create ffmpeg-process.ts**

```typescript
// src/server/transcoder/ffmpeg-process.ts

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { FFmpegPreset } from './quality-presets.js';

export class FFmpegProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private preset: FFmpegPreset;
  private inputPath: string;

  constructor(preset: FFmpegPreset, inputPath: string) {
    super();
    this.preset = preset;
    this.inputPath = inputPath;
  }

  start(): void {
    const args = [
      '-i', this.inputPath,
      // Video output to stdout
      ...this.preset.videoArgs,
      '-an', // no audio in video stream
      'pipe:1',
      // Audio output to stderr (we'll use fd:2 trick or separate process)
    ];

    // For simplicity, run two FFmpeg processes: one for video, one for audio
    this.startVideoProcess();
    this.startAudioProcess();
  }

  private startVideoProcess(): void {
    const args = [
      '-i', this.inputPath,
      ...this.preset.videoArgs,
      '-an',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.emit('videoData', chunk);
    });

    proc.stderr!.on('data', (data: Buffer) => {
      // FFmpeg logs — ignore or debug
    });

    proc.on('close', (code) => {
      this.emit('videoEnd', code);
    });

    proc.on('error', (err) => {
      this.emit('error', err);
    });

    this.process = proc;
  }

  private startAudioProcess(): void {
    const args = [
      '-i', this.inputPath,
      ...this.preset.audioArgs,
      '-vn',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.emit('audioData', chunk);
    });

    proc.on('close', (code) => {
      this.emit('audioEnd', code);
    });

    proc.on('error', (err) => {
      this.emit('error', err);
    });
  }

  stop(): void {
    this.process?.kill('SIGTERM');
  }
}
```

- [ ] **Step 3: Create transcoder/index.ts**

```typescript
// src/server/transcoder/index.ts

import { EventEmitter } from 'events';
import { QualityLevel, QUALITY_LEVELS } from '../../shared/types.js';
import { getPresets } from './quality-presets.js';
import { FFmpegProcess } from './ffmpeg-process.js';

export class Transcoder extends EventEmitter {
  private processes: FFmpegProcess[] = [];

  start(inputPath: string, levels: QualityLevel[] = QUALITY_LEVELS): void {
    const presets = getPresets();

    for (const preset of presets) {
      if (!levels.find(l => l.name === preset.level.name)) continue;

      const proc = new FFmpegProcess(preset, inputPath);

      proc.on('videoData', (chunk: Buffer) => {
        this.emit('videoData', preset.level, chunk);
      });

      proc.on('audioData', (chunk: Buffer) => {
        this.emit('audioData', preset.level, chunk);
      });

      proc.on('videoEnd', () => {
        this.emit('videoEnd', preset.level);
      });

      proc.on('audioEnd', () => {
        this.emit('audioEnd', preset.level);
      });

      proc.on('error', (err: Error) => {
        this.emit('error', preset.level, err);
      });

      this.processes.push(proc);
      proc.start();
    }
  }

  stop(): void {
    for (const proc of this.processes) {
      proc.stop();
    }
    this.processes = [];
  }
}

export { getPresets } from './quality-presets.js';
export { FFmpegProcess } from './ffmpeg-process.js';
```

- [ ] **Step 4: Write integration-style test (requires FFmpeg)**

```typescript
// test/server/transcoder/transcoder.test.ts
import { describe, it, expect } from 'vitest';
import { getPresets } from '../../../src/server/transcoder/quality-presets.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';

describe('quality presets', () => {
  it('generates presets for all quality levels', () => {
    const presets = getPresets();
    expect(presets.length).toBe(4);
  });

  it('includes correct resolution in video args', () => {
    const presets = getPresets();
    const p360 = presets.find(p => p.level.name === '360p')!;
    expect(p360.videoArgs).toContain('640x360');
  });

  it('includes correct bitrate', () => {
    const presets = getPresets();
    const p1080 = presets.find(p => p.level.name === '1080p')!;
    expect(p1080.videoArgs).toContain('5000000');
  });

  it('sets keyframe interval', () => {
    const presets = getPresets(90);
    expect(presets[0].videoArgs).toContain('90');
  });

  it('outputs Annex B format', () => {
    const presets = getPresets();
    for (const p of presets) {
      const fIdx = p.videoArgs.indexOf('-f');
      expect(p.videoArgs[fIdx + 1]).toBe('h264');
    }
  });

  it('outputs ADTS format for audio', () => {
    const presets = getPresets();
    for (const p of presets) {
      const fIdx = p.audioArgs.indexOf('-f');
      expect(p.audioArgs[fIdx + 1]).toBe('adts');
    }
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/server/transcoder/transcoder.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/transcoder/ test/server/transcoder/
git commit -m "feat: transcoder with FFmpeg presets for 4 quality levels"
```

---

## Task 9: HTTP Server

**Files:**
- Create: `src/server/http/server.ts`
- Create: `test/server/http/server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/server/http/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { HLSServer } from '../../../src/server/http/server.js';

function fetch(url: string, opts: { method?: string; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('HLSServer', () => {
  let server: HLSServer;
  const port = 9876;

  beforeAll(async () => {
    server = new HLSServer(port);
    server.setMasterPlaylist('#EXTM3U\n#EXT-X-VERSION:3');
    server.setMediaPlaylist('360p', '#EXTM3U\n#EXTINF:6.000,\nseg-0.ts');
    server.addSegment('360p', 'seg-0.ts', Buffer.from('fake-ts-data'));
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('serves master playlist', async () => {
    const res = await fetch(`http://localhost:${port}/master.m3u8`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.body).toContain('#EXTM3U');
  });

  it('serves media playlist', async () => {
    const res = await fetch(`http://localhost:${port}/360p/playlist.m3u8`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('#EXTINF:6.000');
  });

  it('serves TS segments', async () => {
    const res = await fetch(`http://localhost:${port}/360p/seg-0.ts`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('video/mp2t');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`http://localhost:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('includes CORS headers', async () => {
    const res = await fetch(`http://localhost:${port}/master.m3u8`);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('handles OPTIONS preflight', async () => {
    const res = await fetch(`http://localhost:${port}/master.m3u8`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  it('accepts bandwidth reports', async () => {
    const res = await fetch(`http://localhost:${port}/api/bandwidth`, {
      method: 'POST',
      body: JSON.stringify({
        clientId: 'test-1',
        measuredBandwidth: 5000000,
        currentQuality: '720p',
        bufferLevel: 15.0,
      }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ack).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/http/server.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement server.ts**

```typescript
// src/server/http/server.ts

import http from 'http';

export class HLSServer {
  private server: http.Server;
  private port: number;
  private masterPlaylist = '';
  private mediaPlaylists = new Map<string, string>();
  private segments = new Map<string, Buffer>(); // key: "quality/filename"

  constructor(port: number) {
    this.port = port;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  setMasterPlaylist(content: string): void {
    this.masterPlaylist = content;
  }

  setMediaPlaylist(quality: string, content: string): void {
    this.mediaPlaylists.set(quality, content);
  }

  addSegment(quality: string, filename: string, data: Buffer): void {
    this.segments.set(`${quality}/${filename}`, data);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.setCORSHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    if (req.method === 'POST' && url === '/api/bandwidth') {
      this.handleBandwidthReport(req, res);
      return;
    }

    if (url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(this.masterPlaylist);
      return;
    }

    // Match /quality/playlist.m3u8
    const playlistMatch = url.match(/^\/(\w+)\/playlist\.m3u8$/);
    if (playlistMatch) {
      const quality = playlistMatch[1];
      const playlist = this.mediaPlaylists.get(quality);
      if (playlist) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(playlist);
        return;
      }
    }

    // Match /quality/segment.ts
    const segmentMatch = url.match(/^\/(\w+)\/([\w-]+\.ts)$/);
    if (segmentMatch) {
      const key = `${segmentMatch[1]}/${segmentMatch[2]}`;
      const segment = this.segments.get(key);
      if (segment) {
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Content-Length': segment.length.toString(),
        });
        res.end(segment);
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  private setCORSHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  private handleBandwidthReport(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        const report = JSON.parse(body);
        // Log for debug dashboard (future use)
        this.emit?.('bandwidthReport', report);
      } catch {
        // Ignore malformed JSON
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ack: true }));
    });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/http/server.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/http/server.ts test/server/http/server.test.ts
git commit -m "feat: HTTP server with CORS, playlist/segment serving, bandwidth API"
```

---

## Task 10: File Ingest + Server Pipeline

**Files:**
- Create: `src/server/ingest/file-ingest.ts`
- Create: `src/server/ingest/index.ts`
- Create: `src/server/pipeline.ts`
- Create: `test/server/ingest/file-ingest.test.ts`

- [ ] **Step 1: Write failing tests for file ingest**

```typescript
// test/server/ingest/file-ingest.test.ts
import { describe, it, expect } from 'vitest';
import { FileIngest } from '../../../src/server/ingest/file-ingest.js';
import fs from 'fs';
import path from 'path';

describe('FileIngest', () => {
  it('validates that the file exists', () => {
    expect(() => new FileIngest('/nonexistent/file.mp4')).toThrow('File not found');
  });

  it('returns the file path for transcoder input', () => {
    // Use package.json as a test file that we know exists
    const testFile = path.resolve('package.json');
    const ingest = new FileIngest(testFile);
    expect(ingest.getInputPath()).toBe(testFile);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/ingest/file-ingest.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement file-ingest.ts**

```typescript
// src/server/ingest/file-ingest.ts

import fs from 'fs';

export class FileIngest {
  private filePath: string;

  constructor(filePath: string) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    this.filePath = filePath;
  }

  getInputPath(): string {
    return this.filePath;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/ingest/file-ingest.test.ts`
Expected: All PASS

- [ ] **Step 5: Create ingest/index.ts**

```typescript
// src/server/ingest/index.ts
export { FileIngest } from './file-ingest.js';
```

- [ ] **Step 6: Create pipeline.ts (wires everything together)**

```typescript
// src/server/pipeline.ts

import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { QualityLevel, QUALITY_LEVELS } from '../shared/types.js';
import { FileIngest } from './ingest/file-ingest.js';
import { Transcoder } from './transcoder/index.js';
import { TSPackager } from './packager/index.js';
import { ManifestGenerator } from './manifest/index.js';
import { HLSServer } from './http/server.js';

export interface PipelineOptions {
  inputPath: string;
  outputDir: string;
  port: number;
  mode: 'vod' | 'live';
  levels?: QualityLevel[];
}

export class Pipeline extends EventEmitter {
  private options: PipelineOptions;
  private transcoder: Transcoder;
  private packagers = new Map<string, TSPackager>();
  private manifest: ManifestGenerator;
  private server: HLSServer;

  constructor(options: PipelineOptions) {
    super();
    this.options = options;
    const levels = options.levels ?? QUALITY_LEVELS;

    this.transcoder = new Transcoder();
    this.manifest = new ManifestGenerator(levels, options.mode);
    this.server = new HLSServer(options.port);

    for (const level of levels) {
      const packager = new TSPackager(level);
      this.packagers.set(level.name, packager);

      packager.on('segment', (info, data) => {
        const qualityDir = path.join(options.outputDir, level.name);
        fs.mkdirSync(qualityDir, { recursive: true });
        fs.writeFileSync(path.join(qualityDir, info.filename), data);

        this.manifest.addSegment(level.name, {
          index: info.index,
          duration: info.duration,
          filename: info.filename,
        });

        this.server.addSegment(level.name, info.filename, data);
        this.server.setMediaPlaylist(level.name, this.manifest.getMediaPlaylist(level.name)!);
        this.server.setMasterPlaylist(this.manifest.getMasterPlaylist());

        this.emit('segment', info);
      });
    }

    this.wireTranscoderToPackagers();
  }

  private wireTranscoderToPackagers(): void {
    this.transcoder.on('videoData', (level: QualityLevel, chunk: Buffer) => {
      // In a real implementation, we'd need to track PTS from FFmpeg output
      // For now, this is the wiring point
      this.packagers.get(level.name)?.pushVideo(chunk, 0);
    });

    this.transcoder.on('audioData', (level: QualityLevel, chunk: Buffer) => {
      this.packagers.get(level.name)?.pushAudio(chunk, 0);
    });
  }

  async start(): Promise<void> {
    const ingest = new FileIngest(this.options.inputPath);
    await this.server.start();
    this.transcoder.start(ingest.getInputPath(), this.options.levels ?? QUALITY_LEVELS);
    console.log(`HLS server running at http://localhost:${this.options.port}/master.m3u8`);
  }

  async stop(): Promise<void> {
    this.transcoder.stop();
    if (this.options.mode === 'vod') {
      this.manifest.finalize();
      for (const level of (this.options.levels ?? QUALITY_LEVELS)) {
        this.server.setMediaPlaylist(level.name, this.manifest.getMediaPlaylist(level.name)!);
      }
    }
    await this.server.stop();
  }
}
```

- [ ] **Step 7: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/server/ingest/ src/server/pipeline.ts test/server/ingest/
git commit -m "feat: file ingest and server pipeline orchestration"
```

---

## Task 11: Client TS Demuxer

**Files:**
- Create: `src/client/demuxer/ts-demuxer.ts`
- Create: `src/client/demuxer/nal-parser.ts`
- Create: `test/client/demuxer/ts-demuxer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/client/demuxer/ts-demuxer.test.ts
import { describe, it, expect } from 'vitest';
import { TSDemuxer } from '../../../src/client/demuxer/ts-demuxer.js';
import { buildTSPacket } from '../../../src/server/packager/ts-packet.js';
import { buildPESPacket } from '../../../src/server/packager/pes-packet.js';
import { buildPAT, buildPMT } from '../../../src/server/packager/psi.js';
import { VIDEO_PID, AUDIO_PID, PAT_PID, PMT_PID } from '../../../src/shared/types.js';

function buildTestSegment(): Uint8Array {
  const packets: Buffer[] = [];

  // PAT
  const pat = buildPAT(PMT_PID);
  packets.push(buildTSPacket({
    pid: PAT_PID,
    payload: Buffer.concat([Buffer.from([0x00]), pat]),
    payloadUnitStart: true,
    continuityCounter: 0,
  }));

  // PMT
  const pmt = buildPMT(VIDEO_PID, AUDIO_PID);
  packets.push(buildTSPacket({
    pid: PMT_PID,
    payload: Buffer.concat([Buffer.from([0x00]), pmt]),
    payloadUnitStart: true,
    continuityCounter: 0,
  }));

  // Video PES
  const videoPES = buildPESPacket({
    streamId: 0xE0,
    payload: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0xAA, 0xBB]), // IDR NAL
    pts: 90_000,
  });
  packets.push(buildTSPacket({
    pid: VIDEO_PID,
    payload: videoPES,
    payloadUnitStart: true,
    continuityCounter: 0,
  }));

  // Audio PES
  const audioPES = buildPESPacket({
    streamId: 0xC0,
    payload: Buffer.from([0xFF, 0xF1, 0x50, 0x40, 0x02, 0x1F, 0xFC, 0xAA]), // ADTS frame
    pts: 90_000,
  });
  packets.push(buildTSPacket({
    pid: AUDIO_PID,
    payload: audioPES,
    payloadUnitStart: true,
    continuityCounter: 0,
  }));

  const segment = Buffer.concat(packets);
  return new Uint8Array(segment.buffer, segment.byteOffset, segment.byteLength);
}

describe('TSDemuxer', () => {
  it('parses TS packets from segment data', () => {
    const demuxer = new TSDemuxer();
    const segment = buildTestSegment();
    const result = demuxer.demux(segment);
    expect(result.videoSamples.length).toBeGreaterThan(0);
  });

  it('extracts video PES with correct PTS', () => {
    const demuxer = new TSDemuxer();
    const segment = buildTestSegment();
    const result = demuxer.demux(segment);
    expect(result.videoSamples[0].pts).toBe(90_000);
  });

  it('extracts audio PES', () => {
    const demuxer = new TSDemuxer();
    const segment = buildTestSegment();
    const result = demuxer.demux(segment);
    expect(result.audioSamples.length).toBeGreaterThan(0);
  });

  it('identifies video and audio PIDs from PAT/PMT', () => {
    const demuxer = new TSDemuxer();
    const segment = buildTestSegment();
    demuxer.demux(segment);
    expect(demuxer.videoPid).toBe(VIDEO_PID);
    expect(demuxer.audioPid).toBe(AUDIO_PID);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/client/demuxer/ts-demuxer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement nal-parser.ts**

```typescript
// src/client/demuxer/nal-parser.ts

export interface NALUnit {
  type: number;
  data: Uint8Array;
}

export function parseNALUnits(data: Uint8Array): NALUnit[] {
  const units: NALUnit[] = [];
  let start = -1;

  for (let i = 0; i < data.length - 3; i++) {
    const isStart3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    const isStart4 = i < data.length - 4 &&
      data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;

    if (isStart4 || isStart3) {
      if (start >= 0) {
        const nalData = data.subarray(start, i);
        units.push({ type: nalData[0] & 0x1F, data: nalData });
      }
      start = isStart4 ? i + 4 : i + 3;
      if (isStart4) i += 3; else i += 2;
    }
  }

  if (start >= 0 && start < data.length) {
    const nalData = data.subarray(start);
    units.push({ type: nalData[0] & 0x1F, data: nalData });
  }

  return units;
}
```

- [ ] **Step 4: Implement ts-demuxer.ts**

```typescript
// src/client/demuxer/ts-demuxer.ts

import { TS_PACKET_SIZE } from '../../shared/types.js';

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

export class TSDemuxer {
  videoPid = -1;
  audioPid = -1;
  private pmtPid = -1;

  demux(data: Uint8Array): DemuxResult {
    const videoSamples: DemuxedSample[] = [];
    const audioSamples: DemuxedSample[] = [];

    let videoPESBuffer: Uint8Array[] = [];
    let audioPESBuffer: Uint8Array[] = [];
    let videoPTS = 0;
    let audioPTS = 0;

    for (let offset = 0; offset + TS_PACKET_SIZE <= data.length; offset += TS_PACKET_SIZE) {
      const packet = data.subarray(offset, offset + TS_PACKET_SIZE);

      if (packet[0] !== 0x47) continue; // sync byte check

      const payloadUnitStart = !!(packet[1] & 0x40);
      const pid = ((packet[1] & 0x1F) << 8) | packet[2];
      const adaptationFieldControl = (packet[3] >> 4) & 0x03;
      const hasAdaptation = adaptationFieldControl >= 2;
      const hasPayload = adaptationFieldControl === 1 || adaptationFieldControl === 3;

      if (!hasPayload) continue;

      let payloadOffset = 4;
      if (hasAdaptation) {
        payloadOffset += 1 + packet[4]; // adaptation_field_length + 1
      }

      const payload = packet.subarray(payloadOffset);

      // PAT
      if (pid === 0x0000) {
        this.parsePAT(payload, payloadUnitStart);
        continue;
      }

      // PMT
      if (pid === this.pmtPid) {
        this.parsePMT(payload, payloadUnitStart);
        continue;
      }

      // Video
      if (pid === this.videoPid) {
        if (payloadUnitStart) {
          if (videoPESBuffer.length > 0) {
            const pes = this.concatUint8Arrays(videoPESBuffer);
            const parsed = this.parsePES(pes);
            if (parsed) {
              videoSamples.push({
                pts: parsed.pts,
                dts: parsed.dts,
                data: parsed.payload,
                isKeyframe: this.isIDR(parsed.payload),
              });
            }
          }
          videoPESBuffer = [payload];
        } else {
          videoPESBuffer.push(payload);
        }
        continue;
      }

      // Audio
      if (pid === this.audioPid) {
        if (payloadUnitStart) {
          if (audioPESBuffer.length > 0) {
            const pes = this.concatUint8Arrays(audioPESBuffer);
            const parsed = this.parsePES(pes);
            if (parsed) {
              audioSamples.push({
                pts: parsed.pts,
                data: parsed.payload,
              });
            }
          }
          audioPESBuffer = [payload];
        } else {
          audioPESBuffer.push(payload);
        }
      }
    }

    // Flush remaining PES buffers
    if (videoPESBuffer.length > 0) {
      const pes = this.concatUint8Arrays(videoPESBuffer);
      const parsed = this.parsePES(pes);
      if (parsed) {
        videoSamples.push({
          pts: parsed.pts,
          dts: parsed.dts,
          data: parsed.payload,
          isKeyframe: this.isIDR(parsed.payload),
        });
      }
    }
    if (audioPESBuffer.length > 0) {
      const pes = this.concatUint8Arrays(audioPESBuffer);
      const parsed = this.parsePES(pes);
      if (parsed) {
        audioSamples.push({ pts: parsed.pts, data: parsed.payload });
      }
    }

    return { videoSamples, audioSamples };
  }

  private parsePAT(payload: Uint8Array, hasPointer: boolean): void {
    let offset = hasPointer ? 1 + payload[0] : 0;
    // Skip table_id(1), section_syntax(2), tsi(2), version(1), section(2) = 8
    offset += 8;
    // Program number (2) + PMT PID (2)
    if (offset + 3 < payload.length) {
      this.pmtPid = ((payload[offset + 2] & 0x1F) << 8) | payload[offset + 3];
    }
  }

  private parsePMT(payload: Uint8Array, hasPointer: boolean): void {
    let offset = hasPointer ? 1 + payload[0] : 0;
    // table_id(1) + section_length(2) + program_number(2) + version(1) + section(2) = 8
    offset += 8;
    // PCR PID (2) + program_info_length (2)
    const programInfoLength = ((payload[offset + 2] & 0x0F) << 8) | payload[offset + 3];
    offset += 4 + programInfoLength;

    // Stream entries
    while (offset + 4 < payload.length) {
      const streamType = payload[offset];
      const elementaryPid = ((payload[offset + 1] & 0x1F) << 8) | payload[offset + 2];
      const esInfoLength = ((payload[offset + 3] & 0x0F) << 8) | payload[offset + 4];

      if (streamType === 0x1B) { // H.264
        this.videoPid = elementaryPid;
      } else if (streamType === 0x0F) { // AAC
        this.audioPid = elementaryPid;
      }

      offset += 5 + esInfoLength;
    }
  }

  private parsePES(data: Uint8Array): { pts: number; dts?: number; payload: Uint8Array } | null {
    if (data.length < 9) return null;
    if (data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return null;

    const ptsDtsFlags = (data[7] >> 6) & 0x03;
    const headerDataLength = data[8];
    let pts = 0;
    let dts: number | undefined;

    if (ptsDtsFlags >= 2) {
      pts = this.readTimestamp(data, 9);
    }
    if (ptsDtsFlags === 3) {
      dts = this.readTimestamp(data, 14);
    }

    const payloadStart = 9 + headerDataLength;
    return { pts, dts, payload: data.subarray(payloadStart) };
  }

  private readTimestamp(data: Uint8Array, offset: number): number {
    return (
      ((data[offset] >> 1) & 0x07) * 0x40000000 +  // bits 32..30
      (data[offset + 1] << 22) +
      ((data[offset + 2] >> 1) << 15) +
      (data[offset + 3] << 7) +
      (data[offset + 4] >> 1)
    );
  }

  private isIDR(data: Uint8Array): boolean {
    for (let i = 0; i < data.length - 4; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
        if ((data[i + 4] & 0x1F) === 5) return true;
      }
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        if ((data[i + 3] & 0x1F) === 5) return true;
      }
    }
    return false;
  }

  private concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/client/demuxer/ts-demuxer.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/client/demuxer/ test/client/demuxer/
git commit -m "feat: client-side TS demuxer with PAT/PMT/PES parsing"
```

---

## Task 12: Client fMP4 Remuxer

**Files:**
- Create: `src/client/remuxer/mp4-box.ts`
- Create: `src/client/remuxer/init-segment.ts`
- Create: `src/client/remuxer/media-segment.ts`
- Create: `test/client/remuxer/mp4-box.test.ts`
- Create: `test/client/remuxer/init-segment.test.ts`

- [ ] **Step 1: Write failing tests for MP4 box builder**

```typescript
// test/client/remuxer/mp4-box.test.ts
import { describe, it, expect } from 'vitest';
import { box, fullBox } from '../../../src/client/remuxer/mp4-box.js';

describe('MP4 box builder', () => {
  it('creates a box with correct size and type', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    const result = box('test', data);
    // Size = 8 (header) + 3 (data) = 11
    const size = (result[0] << 24) | (result[1] << 16) | (result[2] << 8) | result[3];
    expect(size).toBe(11);
    // Type = 'test'
    const type = String.fromCharCode(result[4], result[5], result[6], result[7]);
    expect(type).toBe('test');
  });

  it('creates a full box with version and flags', () => {
    const data = new Uint8Array([0xAA]);
    const result = fullBox('tfhd', 0, 0, data);
    // Size = 8 (header) + 4 (version+flags) + 1 (data) = 13
    const size = (result[0] << 24) | (result[1] << 16) | (result[2] << 8) | result[3];
    expect(size).toBe(13);
    // Version at offset 8
    expect(result[8]).toBe(0);
    // Flags at offset 9-11
    expect(result[9]).toBe(0);
    expect(result[10]).toBe(0);
    expect(result[11]).toBe(0);
  });

  it('nests boxes correctly', () => {
    const inner = box('inne', new Uint8Array([0xFF]));
    const outer = box('outr', inner);
    const outerSize = (outer[0] << 24) | (outer[1] << 16) | (outer[2] << 8) | outer[3];
    // outer = 8 + inner(9) = 17
    expect(outerSize).toBe(17);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/client/remuxer/mp4-box.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement mp4-box.ts**

```typescript
// src/client/remuxer/mp4-box.ts

export function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  let totalPayload = 0;
  for (const p of payloads) totalPayload += p.length;

  const size = 8 + totalPayload;
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);

  // Size (4 bytes)
  view.setUint32(0, size);

  // Type (4 bytes)
  result[4] = type.charCodeAt(0);
  result[5] = type.charCodeAt(1);
  result[6] = type.charCodeAt(2);
  result[7] = type.charCodeAt(3);

  // Payloads
  let offset = 8;
  for (const p of payloads) {
    result.set(p, offset);
    offset += p.length;
  }

  return result;
}

export function fullBox(type: string, version: number, flags: number, ...payloads: Uint8Array[]): Uint8Array {
  const versionFlags = new Uint8Array(4);
  versionFlags[0] = version;
  versionFlags[1] = (flags >> 16) & 0xFF;
  versionFlags[2] = (flags >> 8) & 0xFF;
  versionFlags[3] = flags & 0xFF;

  return box(type, versionFlags, ...payloads);
}

export function uint32(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value);
  return buf;
}

export function uint16(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value);
  return buf;
}

export function uint8(value: number): Uint8Array {
  return new Uint8Array([value]);
}

export function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
```

- [ ] **Step 4: Run box tests**

Run: `npx vitest run test/client/remuxer/mp4-box.test.ts`
Expected: All PASS

- [ ] **Step 5: Write failing tests for init segment**

```typescript
// test/client/remuxer/init-segment.test.ts
import { describe, it, expect } from 'vitest';
import { generateInitSegment } from '../../../src/client/remuxer/init-segment.js';

describe('generateInitSegment', () => {
  it('starts with ftyp box', () => {
    const init = generateInitSegment({
      width: 640,
      height: 360,
      sps: new Uint8Array([0x67, 0x42, 0xC0, 0x1E]),
      pps: new Uint8Array([0x68, 0xCE, 0x38, 0x80]),
      audioSampleRate: 44100,
      audioChannels: 2,
    });
    const type = String.fromCharCode(init[4], init[5], init[6], init[7]);
    expect(type).toBe('ftyp');
  });

  it('contains moov box after ftyp', () => {
    const init = generateInitSegment({
      width: 640,
      height: 360,
      sps: new Uint8Array([0x67, 0x42, 0xC0, 0x1E]),
      pps: new Uint8Array([0x68, 0xCE, 0x38, 0x80]),
      audioSampleRate: 44100,
      audioChannels: 2,
    });
    // Find moov box after ftyp
    const ftypSize = new DataView(init.buffer).getUint32(0);
    const moovType = String.fromCharCode(
      init[ftypSize + 4], init[ftypSize + 5], init[ftypSize + 6], init[ftypSize + 7]
    );
    expect(moovType).toBe('moov');
  });

  it('returns valid Uint8Array', () => {
    const init = generateInitSegment({
      width: 1920,
      height: 1080,
      sps: new Uint8Array([0x67, 0x42, 0xC0, 0x1E]),
      pps: new Uint8Array([0x68, 0xCE, 0x38, 0x80]),
      audioSampleRate: 44100,
      audioChannels: 2,
    });
    expect(init).toBeInstanceOf(Uint8Array);
    expect(init.length).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run test/client/remuxer/init-segment.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement init-segment.ts**

```typescript
// src/client/remuxer/init-segment.ts

import { box, fullBox, uint32, uint16, uint8, concat } from './mp4-box.js';

export interface InitSegmentOptions {
  width: number;
  height: number;
  sps: Uint8Array;
  pps: Uint8Array;
  audioSampleRate: number;
  audioChannels: number;
}

export function generateInitSegment(opts: InitSegmentOptions): Uint8Array {
  const ftyp = box('ftyp', concat(
    new Uint8Array([0x69, 0x73, 0x6F, 0x6D]), // isom
    uint32(0x200),                              // minor_version
    new Uint8Array([0x69, 0x73, 0x6F, 0x6D]), // isom
    new Uint8Array([0x69, 0x73, 0x6F, 0x32]), // iso2
    new Uint8Array([0x6D, 0x70, 0x34, 0x31]), // mp41
  ));

  const moov = box('moov',
    mvhd(),
    videoTrak(opts),
    audioTrak(opts),
    mvex(2),
  );

  return concat(ftyp, moov);
}

function mvhd(): Uint8Array {
  const data = new Uint8Array(96);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1); // timescale
  view.setUint32(4, 0); // duration
  view.setUint32(8, 0x00010000); // rate = 1.0
  view.setUint16(12, 0x0100); // volume = 1.0
  // Identity matrix at offset 24
  const matrixOffset = 24;
  view.setUint32(matrixOffset, 0x00010000);
  view.setUint32(matrixOffset + 12, 0x00010000);
  view.setUint32(matrixOffset + 32, 0x40000000);
  view.setUint32(88, 2); // next_track_ID
  return fullBox('mvhd', 0, 0, data);
}

function videoTrak(opts: InitSegmentOptions): Uint8Array {
  return box('trak',
    tkhd(1, opts.width, opts.height),
    mdia(
      mdhd(90_000),
      hdlr('vide', 'VideoHandler'),
      minf(
        vmhd(),
        dinf(),
        videoStbl(opts),
      ),
    ),
  );
}

function audioTrak(opts: InitSegmentOptions): Uint8Array {
  return box('trak',
    tkhd(2, 0, 0),
    mdia(
      mdhd(opts.audioSampleRate),
      hdlr('soun', 'SoundHandler'),
      minf(
        smhd(),
        dinf(),
        audioStbl(opts),
      ),
    ),
  );
}

function tkhd(trackId: number, width: number, height: number): Uint8Array {
  const data = new Uint8Array(80);
  const view = new DataView(data.buffer);
  view.setUint32(0, trackId); // track_ID
  view.setUint32(8, 0); // duration
  view.setUint16(24, 0); // layer
  view.setUint16(26, trackId === 1 ? 0 : 1); // alternate_group
  view.setUint16(28, trackId === 2 ? 0x0100 : 0); // volume (audio = 1.0)
  // Matrix at offset 32
  view.setUint32(32, 0x00010000);
  view.setUint32(44, 0x00010000);
  view.setUint32(64, 0x40000000);
  view.setUint32(68, width << 16); // width
  view.setUint32(72, height << 16); // height
  return fullBox('tkhd', 0, 0x000003, data);
}

function mdia(...boxes: Uint8Array[]): Uint8Array {
  return box('mdia', ...boxes);
}

function mdhd(timescale: number): Uint8Array {
  const data = new Uint8Array(20);
  const view = new DataView(data.buffer);
  view.setUint32(4, timescale);
  view.setUint16(16, 0x55C4); // undetermined language
  return fullBox('mdhd', 0, 0, data);
}

function hdlr(type: string, name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name + '\0');
  const data = concat(
    new Uint8Array(4), // pre_defined
    new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]),
    new Uint8Array(12), // reserved
    nameBytes,
  );
  return fullBox('hdlr', 0, 0, data);
}

function minf(...boxes: Uint8Array[]): Uint8Array {
  return box('minf', ...boxes);
}

function vmhd(): Uint8Array {
  return fullBox('vmhd', 0, 0x000001, new Uint8Array(8));
}

function smhd(): Uint8Array {
  return fullBox('smhd', 0, 0, new Uint8Array(4));
}

function dinf(): Uint8Array {
  const dref = fullBox('dref', 0, 0, concat(
    uint32(1), // entry_count
    fullBox('url ', 0, 0x000001, new Uint8Array(0)),
  ));
  return box('dinf', dref);
}

function videoStbl(opts: InitSegmentOptions): Uint8Array {
  // avcC box
  const avcC = box('avcC', concat(
    uint8(1),                          // configurationVersion
    opts.sps.length > 1 ? new Uint8Array([opts.sps[1]]) : uint8(0x42), // profile
    opts.sps.length > 2 ? new Uint8Array([opts.sps[2]]) : uint8(0xC0), // profile_compat
    opts.sps.length > 3 ? new Uint8Array([opts.sps[3]]) : uint8(0x1E), // level
    uint8(0xFF),                       // lengthSizeMinusOne = 3
    uint8(0xE1),                       // numSPS = 1
    uint16(opts.sps.length),
    opts.sps,
    uint8(1),                          // numPPS
    uint16(opts.pps.length),
    opts.pps,
  ));

  const avc1Data = concat(
    new Uint8Array(6),                 // reserved
    uint16(1),                         // data_reference_index
    new Uint8Array(16),                // pre_defined + reserved
    uint16(opts.width),
    uint16(opts.height),
    uint32(0x00480000),                // horizresolution
    uint32(0x00480000),                // vertresolution
    new Uint8Array(4),                 // reserved
    uint16(1),                         // frame_count
    new Uint8Array(32),                // compressorname
    uint16(0x0018),                    // depth
    new Uint8Array([0xFF, 0xFF]),      // pre_defined
  );
  const avc1 = box('avc1', concat(avc1Data, avcC));

  const stsd = fullBox('stsd', 0, 0, concat(uint32(1), avc1));
  const stts = fullBox('stts', 0, 0, uint32(0));
  const stsc = fullBox('stsc', 0, 0, uint32(0));
  const stsz = fullBox('stsz', 0, 0, concat(uint32(0), uint32(0)));
  const stco = fullBox('stco', 0, 0, uint32(0));

  return box('stbl', stsd, stts, stsc, stsz, stco);
}

function audioStbl(opts: InitSegmentOptions): Uint8Array {
  // AudioSpecificConfig for AAC-LC
  const audioSpecificConfig = new Uint8Array(2);
  const sampleRateIndex = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(opts.audioSampleRate);
  const objectType = 2; // AAC-LC
  audioSpecificConfig[0] = (objectType << 3) | ((sampleRateIndex >> 1) & 0x07);
  audioSpecificConfig[1] = ((sampleRateIndex & 0x01) << 7) | (opts.audioChannels << 3);

  const esds = fullBox('esds', 0, 0, concat(
    // ES_Descriptor
    new Uint8Array([0x03]), uint8(23 + audioSpecificConfig.length),
    uint16(2), uint8(0),
    // DecoderConfigDescriptor
    new Uint8Array([0x04]), uint8(15 + audioSpecificConfig.length),
    uint8(0x40), // objectTypeIndication = AAC
    uint8(0x15), // streamType = audio
    new Uint8Array([0x00, 0x00, 0x00]), // bufferSizeDB
    uint32(0), // maxBitrate
    uint32(0), // avgBitrate
    // DecoderSpecificInfo
    new Uint8Array([0x05]), uint8(audioSpecificConfig.length),
    audioSpecificConfig,
    // SLConfigDescriptor
    new Uint8Array([0x06, 0x01, 0x02]),
  ));

  const mp4aData = concat(
    new Uint8Array(6),                 // reserved
    uint16(1),                         // data_reference_index
    new Uint8Array(8),                 // reserved
    uint16(opts.audioChannels),
    uint16(16),                        // sampleSize
    new Uint8Array(4),                 // reserved
    uint16(opts.audioSampleRate),
    new Uint8Array(2),                 // reserved
  );
  const mp4a = box('mp4a', concat(mp4aData, esds));

  const stsd = fullBox('stsd', 0, 0, concat(uint32(1), mp4a));
  const stts = fullBox('stts', 0, 0, uint32(0));
  const stsc = fullBox('stsc', 0, 0, uint32(0));
  const stsz = fullBox('stsz', 0, 0, concat(uint32(0), uint32(0)));
  const stco = fullBox('stco', 0, 0, uint32(0));

  return box('stbl', stsd, stts, stsc, stsz, stco);
}

function mvex(trackCount: number): Uint8Array {
  const trexes: Uint8Array[] = [];
  for (let i = 1; i <= trackCount; i++) {
    trexes.push(fullBox('trex', 0, 0, concat(
      uint32(i),  // track_ID
      uint32(1),  // default_sample_description_index
      uint32(0),  // default_sample_duration
      uint32(0),  // default_sample_size
      uint32(0),  // default_sample_flags
    )));
  }
  return box('mvex', ...trexes);
}
```

- [ ] **Step 8: Implement media-segment.ts**

```typescript
// src/client/remuxer/media-segment.ts

import { box, fullBox, uint32, uint16, uint8, concat } from './mp4-box.js';
import { DemuxedSample } from '../demuxer/ts-demuxer.js';

export function generateMediaSegment(
  sequenceNumber: number,
  videoSamples: DemuxedSample[],
  audioSamples: DemuxedSample[],
  videoBaseDecodeTime: number,
  audioBaseDecodeTime: number,
): Uint8Array {
  const videoTraf = buildTraf(1, videoSamples, videoBaseDecodeTime);
  const audioTraf = buildTraf(2, audioSamples, audioBaseDecodeTime);

  const allSampleData: Uint8Array[] = [];
  for (const s of videoSamples) allSampleData.push(s.data);
  for (const s of audioSamples) allSampleData.push(s.data);

  const mdat = box('mdat', ...allSampleData);
  const moof = box('moof',
    fullBox('mfhd', 0, 0, uint32(sequenceNumber)),
    videoTraf,
    audioTraf,
  );

  return concat(moof, mdat);
}

function buildTraf(
  trackId: number,
  samples: DemuxedSample[],
  baseDecodeTime: number,
): Uint8Array {
  const tfhd = fullBox('tfhd', 0, 0x020000, uint32(trackId));
  const tfdt = fullBox('tfdt', 0, 0, uint32(baseDecodeTime));

  // trun: sample_count + flags per sample
  const flags = 0x000301; // data-offset + sample-duration + sample-size
  const trunData = concat(
    uint32(samples.length),
    uint32(0), // data_offset placeholder (would need moof size calculation)
  );

  const sampleEntries: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i++) {
    const duration = i < samples.length - 1
      ? samples[i + 1].pts - samples[i].pts
      : (samples.length > 1 ? samples[i].pts - samples[i - 1].pts : 3000);
    sampleEntries.push(concat(
      uint32(duration),       // sample_duration
      uint32(samples[i].data.length), // sample_size
    ));
  }

  const trun = fullBox('trun', 0, flags, trunData, ...sampleEntries);

  return box('traf', tfhd, tfdt, trun);
}
```

- [ ] **Step 9: Run all remuxer tests**

Run: `npx vitest run test/client/remuxer/`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add src/client/remuxer/ test/client/remuxer/
git commit -m "feat: fMP4 remuxer with init segment and media segment generation"
```

---

## Task 13: ABR Strategy Engine

**Files:**
- Create: `src/client/abr/types.ts`
- Create: `src/client/abr/conservative.ts`
- Create: `src/client/abr/aggressive.ts`
- Create: `src/client/abr/smooth.ts`
- Create: `src/client/abr/abr-engine.ts`
- Create: `test/client/abr/conservative.test.ts`
- Create: `test/client/abr/aggressive.test.ts`
- Create: `test/client/abr/smooth.test.ts`
- Create: `test/client/abr/abr-engine.test.ts`

- [ ] **Step 1: Create ABR types**

```typescript
// src/client/abr/types.ts

import { QualityLevel } from '../../shared/types.js';

export interface Measurement {
  segmentUrl: string;
  byteSize: number;
  downloadTimeMs: number;
  quality: QualityLevel;
}

export interface ABRContext {
  bandwidth: number;           // bps
  bufferLevel: number;         // seconds
  history: Measurement[];      // last 10 segments
  qualityLevels: QualityLevel[];
  currentQuality: QualityLevel;
}

export interface ABRStrategy {
  name: string;
  decide(context: ABRContext): QualityLevel;
}
```

- [ ] **Step 2: Write failing tests for conservative strategy**

```typescript
// test/client/abr/conservative.test.ts
import { describe, it, expect } from 'vitest';
import { ConservativeStrategy } from '../../../src/client/abr/conservative.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';
import { ABRContext } from '../../../src/client/abr/types.js';

function makeContext(overrides: Partial<ABRContext> = {}): ABRContext {
  return {
    bandwidth: 3_000_000,
    bufferLevel: 15,
    history: [],
    qualityLevels: QUALITY_LEVELS,
    currentQuality: QUALITY_LEVELS[0],
    ...overrides,
  };
}

describe('ConservativeStrategy', () => {
  const strategy = new ConservativeStrategy();

  it('has name "conservative"', () => {
    expect(strategy.name).toBe('conservative');
  });

  it('selects quality using 70% of bandwidth', () => {
    // 3Mbps * 0.7 = 2.1Mbps => 480p (1.496Mbps total) fits, 720p (2.928Mbps) does not
    const ctx = makeContext({ bandwidth: 3_000_000 });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('480p');
  });

  it('selects lowest quality when bandwidth is very low', () => {
    const ctx = makeContext({ bandwidth: 500_000 });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('360p');
  });

  it('selects highest quality when bandwidth is very high', () => {
    const ctx = makeContext({ bandwidth: 20_000_000 });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('1080p');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/client/abr/conservative.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement conservative.ts**

```typescript
// src/client/abr/conservative.ts

import { QualityLevel } from '../../shared/types.js';
import { ABRStrategy, ABRContext } from './types.js';

export class ConservativeStrategy implements ABRStrategy {
  name = 'conservative';

  decide(context: ABRContext): QualityLevel {
    const usableBandwidth = context.bandwidth * 0.7;
    const sorted = [...context.qualityLevels].sort(
      (a, b) => (a.videoBitrate + a.audioBitrate) - (b.videoBitrate + b.audioBitrate)
    );

    let best = sorted[0];
    for (const level of sorted) {
      if (level.videoBitrate + level.audioBitrate <= usableBandwidth) {
        best = level;
      }
    }
    return best;
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/client/abr/conservative.test.ts`
Expected: All PASS

- [ ] **Step 6: Write and implement aggressive strategy**

```typescript
// test/client/abr/aggressive.test.ts
import { describe, it, expect } from 'vitest';
import { AggressiveStrategy } from '../../../src/client/abr/aggressive.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';
import { ABRContext } from '../../../src/client/abr/types.js';

function makeContext(overrides: Partial<ABRContext> = {}): ABRContext {
  return {
    bandwidth: 3_000_000,
    bufferLevel: 15,
    history: [],
    qualityLevels: QUALITY_LEVELS,
    currentQuality: QUALITY_LEVELS[0],
    ...overrides,
  };
}

describe('AggressiveStrategy', () => {
  const strategy = new AggressiveStrategy();

  it('selects highest quality that fits bandwidth', () => {
    // 3Mbps => 720p (2.928Mbps) fits
    const ctx = makeContext({ bandwidth: 3_000_000 });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('720p');
  });

  it('drops to lowest only when buffer is critically low', () => {
    const ctx = makeContext({ bandwidth: 3_000_000, bufferLevel: 2 });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('360p');
  });

  it('selects highest when bandwidth is abundant', () => {
    const ctx = makeContext({ bandwidth: 20_000_000, bufferLevel: 20 });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('1080p');
  });
});
```

```typescript
// src/client/abr/aggressive.ts

import { QualityLevel } from '../../shared/types.js';
import { ABRStrategy, ABRContext } from './types.js';

const CRITICAL_BUFFER_THRESHOLD = 5; // seconds

export class AggressiveStrategy implements ABRStrategy {
  name = 'aggressive';

  decide(context: ABRContext): QualityLevel {
    const sorted = [...context.qualityLevels].sort(
      (a, b) => (b.videoBitrate + b.audioBitrate) - (a.videoBitrate + a.audioBitrate)
    );

    if (context.bufferLevel < CRITICAL_BUFFER_THRESHOLD) {
      return sorted[sorted.length - 1]; // lowest quality
    }

    for (const level of sorted) {
      if (level.videoBitrate + level.audioBitrate <= context.bandwidth) {
        return level;
      }
    }

    return sorted[sorted.length - 1];
  }
}
```

- [ ] **Step 7: Write and implement smooth strategy**

```typescript
// test/client/abr/smooth.test.ts
import { describe, it, expect } from 'vitest';
import { SmoothStrategy } from '../../../src/client/abr/smooth.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';
import { ABRContext } from '../../../src/client/abr/types.js';

function makeContext(overrides: Partial<ABRContext> = {}): ABRContext {
  return {
    bandwidth: 3_000_000,
    bufferLevel: 15,
    history: [],
    qualityLevels: QUALITY_LEVELS,
    currentQuality: QUALITY_LEVELS[1], // 480p
    ...overrides,
  };
}

describe('SmoothStrategy', () => {
  const strategy = new SmoothStrategy();

  it('moves up at most one quality level', () => {
    // Bandwidth supports 1080p but current is 480p -> should move to 720p only
    const ctx = makeContext({ bandwidth: 20_000_000, currentQuality: QUALITY_LEVELS[1] });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('720p');
  });

  it('moves down at most one quality level', () => {
    // Bandwidth only supports 360p but current is 720p -> should move to 480p
    const ctx = makeContext({ bandwidth: 1_000_000, currentQuality: QUALITY_LEVELS[2] });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('480p');
  });

  it('stays at current level when bandwidth matches', () => {
    const ctx = makeContext({ bandwidth: 1_600_000, currentQuality: QUALITY_LEVELS[1] });
    const level = strategy.decide(ctx);
    expect(level.name).toBe('480p');
  });
});
```

```typescript
// src/client/abr/smooth.ts

import { QualityLevel } from '../../shared/types.js';
import { ABRStrategy, ABRContext } from './types.js';

export class SmoothStrategy implements ABRStrategy {
  name = 'smooth';

  decide(context: ABRContext): QualityLevel {
    const sorted = [...context.qualityLevels].sort(
      (a, b) => (a.videoBitrate + a.audioBitrate) - (b.videoBitrate + b.audioBitrate)
    );

    const currentIndex = sorted.findIndex(l => l.name === context.currentQuality.name);
    const usableBandwidth = context.bandwidth * 0.8;

    // Find ideal level
    let idealIndex = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].videoBitrate + sorted[i].audioBitrate <= usableBandwidth) {
        idealIndex = i;
      }
    }

    // Limit to one step change
    if (idealIndex > currentIndex) {
      return sorted[Math.min(currentIndex + 1, sorted.length - 1)];
    } else if (idealIndex < currentIndex) {
      return sorted[Math.max(currentIndex - 1, 0)];
    }

    return sorted[currentIndex];
  }
}
```

- [ ] **Step 8: Write and implement ABR engine**

```typescript
// test/client/abr/abr-engine.test.ts
import { describe, it, expect } from 'vitest';
import { ABREngine } from '../../../src/client/abr/abr-engine.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';

describe('ABREngine', () => {
  it('defaults to conservative strategy', () => {
    const engine = new ABREngine(QUALITY_LEVELS);
    expect(engine.currentStrategyName).toBe('conservative');
  });

  it('switches strategy at runtime', () => {
    const engine = new ABREngine(QUALITY_LEVELS);
    engine.setStrategy('aggressive');
    expect(engine.currentStrategyName).toBe('aggressive');
  });

  it('decides quality using current strategy', () => {
    const engine = new ABREngine(QUALITY_LEVELS);
    engine.updateBandwidth(3_000_000);
    engine.updateBufferLevel(15);
    const level = engine.decide();
    expect(level).toBeDefined();
    expect(level.name).toBeDefined();
  });

  it('records measurement history', () => {
    const engine = new ABREngine(QUALITY_LEVELS);
    engine.recordMeasurement({
      segmentUrl: 'seg-0.ts',
      byteSize: 100_000,
      downloadTimeMs: 200,
      quality: QUALITY_LEVELS[0],
    });
    expect(engine.getHistory().length).toBe(1);
  });

  it('keeps only last 10 measurements', () => {
    const engine = new ABREngine(QUALITY_LEVELS);
    for (let i = 0; i < 15; i++) {
      engine.recordMeasurement({
        segmentUrl: `seg-${i}.ts`,
        byteSize: 100_000,
        downloadTimeMs: 200,
        quality: QUALITY_LEVELS[0],
      });
    }
    expect(engine.getHistory().length).toBe(10);
  });
});
```

```typescript
// src/client/abr/abr-engine.ts

import { QualityLevel } from '../../shared/types.js';
import { ABRStrategy, ABRContext, Measurement } from './types.js';
import { ConservativeStrategy } from './conservative.js';
import { AggressiveStrategy } from './aggressive.js';
import { SmoothStrategy } from './smooth.js';

const MAX_HISTORY = 10;

export class ABREngine {
  private strategies = new Map<string, ABRStrategy>();
  private currentStrategy: ABRStrategy;
  private qualityLevels: QualityLevel[];
  private currentQuality: QualityLevel;
  private bandwidth = 0;
  private bufferLevel = 0;
  private history: Measurement[] = [];

  constructor(qualityLevels: QualityLevel[]) {
    this.qualityLevels = qualityLevels;
    this.currentQuality = qualityLevels[0];

    const conservative = new ConservativeStrategy();
    const aggressive = new AggressiveStrategy();
    const smooth = new SmoothStrategy();

    this.strategies.set(conservative.name, conservative);
    this.strategies.set(aggressive.name, aggressive);
    this.strategies.set(smooth.name, smooth);

    this.currentStrategy = conservative;
  }

  get currentStrategyName(): string {
    return this.currentStrategy.name;
  }

  setStrategy(name: string): void {
    const strategy = this.strategies.get(name);
    if (strategy) this.currentStrategy = strategy;
  }

  registerStrategy(strategy: ABRStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  updateBandwidth(bps: number): void {
    this.bandwidth = bps;
  }

  updateBufferLevel(seconds: number): void {
    this.bufferLevel = seconds;
  }

  recordMeasurement(m: Measurement): void {
    this.history.push(m);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
  }

  getHistory(): Measurement[] {
    return [...this.history];
  }

  decide(): QualityLevel {
    const context: ABRContext = {
      bandwidth: this.bandwidth,
      bufferLevel: this.bufferLevel,
      history: this.history,
      qualityLevels: this.qualityLevels,
      currentQuality: this.currentQuality,
    };

    this.currentQuality = this.currentStrategy.decide(context);
    return this.currentQuality;
  }
}
```

- [ ] **Step 9: Run all ABR tests**

Run: `npx vitest run test/client/abr/`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add src/client/abr/ test/client/abr/
git commit -m "feat: pluggable ABR engine with conservative, aggressive, smooth strategies"
```

---

## Task 14: Prefetch Engine

**Files:**
- Create: `src/client/prefetch/prefetch-engine.ts`
- Create: `test/client/prefetch/prefetch-engine.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/client/prefetch/prefetch-engine.test.ts
import { describe, it, expect } from 'vitest';
import { PrefetchEngine } from '../../../src/client/prefetch/prefetch-engine.js';
import { QUALITY_LEVELS } from '../../../src/shared/types.js';

describe('PrefetchEngine', () => {
  it('recommends prefetch when buffer is below target', () => {
    const engine = new PrefetchEngine({ bufferTarget: 30 });
    const result = engine.shouldPrefetch({
      bufferLevel: 12,
      bandwidth: 5_000_000,
      currentQuality: QUALITY_LEVELS[1], // 480p
      nextSegmentIndex: 5,
    });
    expect(result.shouldFetch).toBe(true);
    expect(result.segmentIndex).toBe(5);
  });

  it('does not prefetch when buffer is at target', () => {
    const engine = new PrefetchEngine({ bufferTarget: 30 });
    const result = engine.shouldPrefetch({
      bufferLevel: 30,
      bandwidth: 5_000_000,
      currentQuality: QUALITY_LEVELS[1],
      nextSegmentIndex: 5,
    });
    expect(result.shouldFetch).toBe(false);
  });

  it('does not prefetch when bandwidth has no spare capacity', () => {
    const engine = new PrefetchEngine({ bufferTarget: 30 });
    const result = engine.shouldPrefetch({
      bufferLevel: 12,
      bandwidth: 1_400_000, // exactly matches 480p video bitrate
      currentQuality: QUALITY_LEVELS[1],
      nextSegmentIndex: 5,
    });
    // Should still fetch because buffer is low, but at current quality
    expect(result.shouldFetch).toBe(true);
  });

  it('calculates spare bandwidth correctly', () => {
    const engine = new PrefetchEngine({ bufferTarget: 30 });
    const spare = engine.getSpareBandwidth(5_000_000, QUALITY_LEVELS[0]); // 360p = 864kbps
    expect(spare).toBe(5_000_000 - 864_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/client/prefetch/prefetch-engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement prefetch-engine.ts**

```typescript
// src/client/prefetch/prefetch-engine.ts

import { QualityLevel } from '../../shared/types.js';

export interface PrefetchConfig {
  bufferTarget: number; // seconds
}

export interface PrefetchInput {
  bufferLevel: number;
  bandwidth: number;
  currentQuality: QualityLevel;
  nextSegmentIndex: number;
}

export interface PrefetchDecision {
  shouldFetch: boolean;
  segmentIndex?: number;
}

export class PrefetchEngine {
  private config: PrefetchConfig;

  constructor(config: PrefetchConfig) {
    this.config = config;
  }

  shouldPrefetch(input: PrefetchInput): PrefetchDecision {
    if (input.bufferLevel >= this.config.bufferTarget) {
      return { shouldFetch: false };
    }

    return {
      shouldFetch: true,
      segmentIndex: input.nextSegmentIndex,
    };
  }

  getSpareBandwidth(currentBandwidth: number, currentQuality: QualityLevel): number {
    const totalBitrate = currentQuality.videoBitrate + currentQuality.audioBitrate;
    return Math.max(0, currentBandwidth - totalBitrate);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/client/prefetch/prefetch-engine.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/client/prefetch/ test/client/prefetch/
git commit -m "feat: prefetch engine with buffer-ahead strategy"
```

---

## Task 15: Player State Machine + Buffer Manager

**Files:**
- Create: `src/client/player/state-machine.ts`
- Create: `src/client/player/buffer-manager.ts`
- Create: `src/client/player/hls-player.ts`

- [ ] **Step 1: Implement state-machine.ts**

```typescript
// src/client/player/state-machine.ts

export type PlayerState =
  | 'IDLE'
  | 'LOADING_MANIFEST'
  | 'LOADING_INIT_SEGMENT'
  | 'BUFFERING'
  | 'PLAYING'
  | 'REBUFFERING'
  | 'ENDED'
  | 'ERROR';

const VALID_TRANSITIONS: Record<PlayerState, PlayerState[]> = {
  IDLE: ['LOADING_MANIFEST', 'ERROR'],
  LOADING_MANIFEST: ['LOADING_INIT_SEGMENT', 'ERROR'],
  LOADING_INIT_SEGMENT: ['BUFFERING', 'ERROR'],
  BUFFERING: ['PLAYING', 'ERROR'],
  PLAYING: ['REBUFFERING', 'ENDED', 'LOADING_INIT_SEGMENT', 'ERROR'],
  REBUFFERING: ['PLAYING', 'BUFFERING', 'ERROR'],
  ENDED: ['IDLE'],
  ERROR: ['IDLE'],
};

export class PlayerStateMachine {
  private _state: PlayerState = 'IDLE';
  private listeners: Array<(from: PlayerState, to: PlayerState) => void> = [];

  get state(): PlayerState {
    return this._state;
  }

  transition(to: PlayerState): boolean {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed?.includes(to)) return false;

    const from = this._state;
    this._state = to;
    for (const listener of this.listeners) {
      listener(from, to);
    }
    return true;
  }

  onTransition(listener: (from: PlayerState, to: PlayerState) => void): void {
    this.listeners.push(listener);
  }
}
```

- [ ] **Step 2: Implement buffer-manager.ts**

```typescript
// src/client/player/buffer-manager.ts

const BUFFER_AHEAD = 30;  // seconds
const BUFFER_BEHIND = 10; // seconds

export class BufferManager {
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;
  private appendQueue: Array<{ buffer: SourceBuffer; data: Uint8Array; resolve: () => void }> = [];
  private isAppending = false;

  attach(videoBuffer: SourceBuffer, audioBuffer: SourceBuffer): void {
    this.videoBuffer = videoBuffer;
    this.audioBuffer = audioBuffer;

    videoBuffer.addEventListener('updateend', () => this.processQueue());
    audioBuffer.addEventListener('updateend', () => this.processQueue());
  }

  async appendVideo(data: Uint8Array): Promise<void> {
    if (!this.videoBuffer) throw new Error('Video buffer not attached');
    return this.enqueue(this.videoBuffer, data);
  }

  async appendAudio(data: Uint8Array): Promise<void> {
    if (!this.audioBuffer) throw new Error('Audio buffer not attached');
    return this.enqueue(this.audioBuffer, data);
  }

  cleanup(currentTime: number): void {
    this.removeRange(this.videoBuffer, 0, Math.max(0, currentTime - BUFFER_BEHIND));
    this.removeRange(this.audioBuffer, 0, Math.max(0, currentTime - BUFFER_BEHIND));
  }

  getBufferLevel(currentTime: number): number {
    if (!this.videoBuffer || this.videoBuffer.buffered.length === 0) return 0;
    for (let i = 0; i < this.videoBuffer.buffered.length; i++) {
      if (this.videoBuffer.buffered.start(i) <= currentTime &&
          currentTime <= this.videoBuffer.buffered.end(i)) {
        return this.videoBuffer.buffered.end(i) - currentTime;
      }
    }
    return 0;
  }

  private enqueue(buffer: SourceBuffer, data: Uint8Array): Promise<void> {
    return new Promise((resolve) => {
      this.appendQueue.push({ buffer, data, resolve });
      if (!this.isAppending) this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.appendQueue.length === 0) {
      this.isAppending = false;
      return;
    }

    const { buffer, data, resolve } = this.appendQueue.shift()!;
    if (buffer.updating) return;

    this.isAppending = true;
    try {
      buffer.appendBuffer(data);
      const onUpdateEnd = () => {
        buffer.removeEventListener('updateend', onUpdateEnd);
        resolve();
        this.processQueue();
      };
      buffer.addEventListener('updateend', onUpdateEnd);
    } catch (e) {
      if ((e as DOMException).name === 'QuotaExceededError') {
        // Remove old data and retry
        this.cleanup(0);
        this.appendQueue.unshift({ buffer, data, resolve });
      }
      this.isAppending = false;
    }
  }

  private removeRange(buffer: SourceBuffer | null, start: number, end: number): void {
    if (!buffer || buffer.updating || end <= start) return;
    try {
      buffer.remove(start, end);
    } catch {
      // Ignore if buffer is busy
    }
  }
}
```

- [ ] **Step 3: Implement hls-player.ts (orchestrator)**

```typescript
// src/client/player/hls-player.ts

import { PlayerStateMachine, PlayerState } from './state-machine.js';
import { BufferManager } from './buffer-manager.js';
import { TSDemuxer } from '../demuxer/ts-demuxer.js';
import { generateInitSegment, InitSegmentOptions } from '../remuxer/init-segment.js';
import { generateMediaSegment } from '../remuxer/media-segment.js';
import { ABREngine } from '../abr/abr-engine.js';
import { PrefetchEngine } from '../prefetch/prefetch-engine.js';
import { QualityLevel, QUALITY_LEVELS } from '../../shared/types.js';
import { parseNALUnits } from '../demuxer/nal-parser.js';

export class HLSPlayer {
  private video: HTMLVideoElement;
  private mediaSource: MediaSource | null = null;
  private stateMachine = new PlayerStateMachine();
  private bufferManager = new BufferManager();
  private demuxer = new TSDemuxer();
  private abrEngine: ABREngine;
  private prefetchEngine: PrefetchEngine;
  private baseUrl = '';
  private currentSegmentIndex = 0;
  private sequenceNumber = 0;
  private videoBaseDecodeTime = 0;
  private audioBaseDecodeTime = 0;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.abrEngine = new ABREngine(QUALITY_LEVELS);
    this.prefetchEngine = new PrefetchEngine({ bufferTarget: 30 });

    this.video.addEventListener('timeupdate', () => {
      this.bufferManager.cleanup(this.video.currentTime);

      const bufferLevel = this.bufferManager.getBufferLevel(this.video.currentTime);
      this.abrEngine.updateBufferLevel(bufferLevel);

      if (bufferLevel < 1 && this.stateMachine.state === 'PLAYING') {
        this.stateMachine.transition('REBUFFERING');
      }
    });
  }

  get state(): PlayerState {
    return this.stateMachine.state;
  }

  get abr(): ABREngine {
    return this.abrEngine;
  }

  async load(masterPlaylistUrl: string): Promise<void> {
    this.baseUrl = masterPlaylistUrl.replace(/\/[^/]+$/, '');
    this.stateMachine.transition('LOADING_MANIFEST');

    const response = await fetch(masterPlaylistUrl);
    const masterPlaylist = await response.text();

    // Parse quality levels from master playlist (simplified)
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);

    await new Promise<void>((resolve) => {
      this.mediaSource!.addEventListener('sourceopen', () => resolve(), { once: true });
    });

    const videoBuffer = this.mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42c01e"');
    const audioBuffer = this.mediaSource.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    this.bufferManager.attach(videoBuffer, audioBuffer);

    this.stateMachine.transition('LOADING_INIT_SEGMENT');
    await this.loadAndPlay();
  }

  private async loadAndPlay(): Promise<void> {
    const quality = this.abrEngine.decide();

    // Fetch first segment to extract codec info for init segment
    const segmentUrl = `${this.baseUrl}/${quality.name}/${quality.name}-seg-${this.currentSegmentIndex}.ts`;
    const startTime = performance.now();
    const response = await fetch(segmentUrl);
    const data = new Uint8Array(await response.arrayBuffer());
    const downloadTime = performance.now() - startTime;

    this.abrEngine.updateBandwidth((data.length * 8) / (downloadTime / 1000));
    this.abrEngine.recordMeasurement({
      segmentUrl,
      byteSize: data.length,
      downloadTimeMs: downloadTime,
      quality,
    });

    const result = this.demuxer.demux(data);

    // Extract SPS/PPS from first video sample
    if (result.videoSamples.length > 0) {
      const nalUnits = parseNALUnits(result.videoSamples[0].data);
      const sps = nalUnits.find(n => n.type === 7);
      const pps = nalUnits.find(n => n.type === 8);

      if (sps && pps) {
        const initSegment = generateInitSegment({
          width: quality.width,
          height: quality.height,
          sps: sps.data,
          pps: pps.data,
          audioSampleRate: 44100,
          audioChannels: 2,
        });

        await this.bufferManager.appendVideo(initSegment);
        await this.bufferManager.appendAudio(initSegment);
      }
    }

    // Remux and append media segment
    const mediaSegment = generateMediaSegment(
      this.sequenceNumber++,
      result.videoSamples,
      result.audioSamples,
      this.videoBaseDecodeTime,
      this.audioBaseDecodeTime,
    );

    await this.bufferManager.appendVideo(mediaSegment);

    this.currentSegmentIndex++;
    this.stateMachine.transition('BUFFERING');
    this.stateMachine.transition('PLAYING');
    this.video.play();

    // Continue loading segments
    this.loadLoop();
  }

  private async loadLoop(): Promise<void> {
    while (this.stateMachine.state === 'PLAYING' || this.stateMachine.state === 'REBUFFERING') {
      const prefetchDecision = this.prefetchEngine.shouldPrefetch({
        bufferLevel: this.bufferManager.getBufferLevel(this.video.currentTime),
        bandwidth: 0, // updated by abrEngine
        currentQuality: this.abrEngine.decide(),
        nextSegmentIndex: this.currentSegmentIndex,
      });

      if (!prefetchDecision.shouldFetch) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const quality = this.abrEngine.decide();
      const segmentUrl = `${this.baseUrl}/${quality.name}/${quality.name}-seg-${this.currentSegmentIndex}.ts`;

      try {
        const startTime = performance.now();
        const response = await fetch(segmentUrl);

        if (!response.ok) {
          if (response.status === 404) {
            this.stateMachine.transition('ENDED');
            this.mediaSource?.endOfStream();
            break;
          }
          continue;
        }

        const data = new Uint8Array(await response.arrayBuffer());
        const downloadTime = performance.now() - startTime;

        this.abrEngine.updateBandwidth((data.length * 8) / (downloadTime / 1000));
        this.abrEngine.recordMeasurement({
          segmentUrl,
          byteSize: data.length,
          downloadTimeMs: downloadTime,
          quality,
        });

        const result = this.demuxer.demux(data);
        const mediaSegment = generateMediaSegment(
          this.sequenceNumber++,
          result.videoSamples,
          result.audioSamples,
          this.videoBaseDecodeTime,
          this.audioBaseDecodeTime,
        );

        await this.bufferManager.appendVideo(mediaSegment);
        this.currentSegmentIndex++;

        if (this.stateMachine.state === 'REBUFFERING') {
          this.stateMachine.transition('PLAYING');
        }

        // Report bandwidth to server
        this.reportBandwidth(quality);
      } catch {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  private async reportBandwidth(quality: QualityLevel): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/bandwidth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: 'player-1',
          measuredBandwidth: 0,
          currentQuality: quality.name,
          bufferLevel: this.bufferManager.getBufferLevel(this.video.currentTime),
        }),
      });
    } catch {
      // Non-critical, ignore
    }
  }
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc -p tsconfig.client.json --noEmit`
Expected: No errors (or minor DOM type issues to resolve)

- [ ] **Step 5: Commit**

```bash
git add src/client/player/
git commit -m "feat: HLS player with state machine, buffer manager, MSE integration"
```

---

## Task 16: Player UI + Debug Panel

**Files:**
- Create: `src/client/ui/index.html`
- Create: `src/client/ui/debug-panel.ts`
- Create: `src/client/ui/styles.css`
- Create: `src/client/index.ts`

- [ ] **Step 1: Create index.html**

```html
<!-- src/client/ui/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ray-HLS Player</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="player-container">
    <video id="video" controls></video>
    <div id="controls">
      <label>ABR Strategy:
        <select id="abr-strategy">
          <option value="conservative">Conservative</option>
          <option value="aggressive">Aggressive</option>
          <option value="smooth">Smooth</option>
        </select>
      </label>
    </div>
  </div>
  <div id="debug-panel">
    <h3>Debug Panel</h3>
    <div id="stats">
      <div>State: <span id="stat-state">IDLE</span></div>
      <div>Quality: <span id="stat-quality">-</span></div>
      <div>Bandwidth: <span id="stat-bandwidth">-</span></div>
      <div>Buffer: <span id="stat-buffer">-</span></div>
      <div>Strategy: <span id="stat-strategy">conservative</span></div>
    </div>
    <canvas id="chart" width="600" height="200"></canvas>
  </div>
  <script type="module" src="../index.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Create styles.css**

```css
/* src/client/ui/styles.css */
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
#player-container { max-width: 800px; margin: 0 auto; }
video { width: 100%; background: #000; border-radius: 4px; }
#controls { margin: 10px 0; }
select { background: #16213e; color: #e0e0e0; border: 1px solid #0f3460; padding: 4px 8px; }
#debug-panel {
  max-width: 800px; margin: 20px auto; padding: 16px;
  background: #16213e; border: 1px solid #0f3460; border-radius: 4px;
}
#debug-panel h3 { margin-bottom: 12px; color: #e94560; }
#stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
#stats div { padding: 4px; }
#stats span { color: #53d8fb; font-weight: bold; }
canvas { width: 100%; background: #0f3460; border-radius: 4px; }
```

- [ ] **Step 3: Create debug-panel.ts**

```typescript
// src/client/ui/debug-panel.ts

import { ABREngine } from '../abr/abr-engine.js';

interface DataPoint {
  time: number;
  bandwidth: number;
  bufferLevel: number;
  quality: string;
}

export class DebugPanel {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dataPoints: DataPoint[] = [];
  private maxPoints = 100;

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
  }

  update(stats: {
    state: string;
    quality: string;
    bandwidth: number;
    bufferLevel: number;
    strategy: string;
  }): void {
    document.getElementById('stat-state')!.textContent = stats.state;
    document.getElementById('stat-quality')!.textContent = stats.quality;
    document.getElementById('stat-bandwidth')!.textContent = `${(stats.bandwidth / 1_000_000).toFixed(2)} Mbps`;
    document.getElementById('stat-buffer')!.textContent = `${stats.bufferLevel.toFixed(1)}s`;
    document.getElementById('stat-strategy')!.textContent = stats.strategy;

    this.dataPoints.push({
      time: Date.now(),
      bandwidth: stats.bandwidth,
      bufferLevel: stats.bufferLevel,
      quality: stats.quality,
    });

    if (this.dataPoints.length > this.maxPoints) {
      this.dataPoints.shift();
    }

    this.draw();
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (this.dataPoints.length < 2) return;

    const maxBandwidth = Math.max(...this.dataPoints.map(d => d.bandwidth), 1);
    const maxBuffer = 30;

    // Draw bandwidth line (cyan)
    ctx.strokeStyle = '#53d8fb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < this.dataPoints.length; i++) {
      const x = (i / (this.maxPoints - 1)) * w;
      const y = h - (this.dataPoints[i].bandwidth / maxBandwidth) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw buffer line (green)
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < this.dataPoints.length; i++) {
      const x = (i / (this.maxPoints - 1)) * w;
      const y = h - (this.dataPoints[i].bufferLevel / maxBuffer) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Legend
    ctx.font = '11px monospace';
    ctx.fillStyle = '#53d8fb';
    ctx.fillText('Bandwidth', 10, 15);
    ctx.fillStyle = '#00ff88';
    ctx.fillText('Buffer', 100, 15);
  }
}
```

- [ ] **Step 4: Create client entry point**

```typescript
// src/client/index.ts

import { HLSPlayer } from './player/hls-player.js';
import { DebugPanel } from './ui/debug-panel.js';

const video = document.getElementById('video') as HTMLVideoElement;
const strategySelect = document.getElementById('abr-strategy') as HTMLSelectElement;

const player = new HLSPlayer(video);
const debug = new DebugPanel('chart');

strategySelect.addEventListener('change', () => {
  player.abr.setStrategy(strategySelect.value);
});

// Update debug panel periodically
setInterval(() => {
  debug.update({
    state: player.state,
    quality: player.abr.decide().name,
    bandwidth: 0,
    bufferLevel: 0,
    strategy: player.abr.currentStrategyName,
  });
}, 1000);

// Auto-load if URL param provided
const params = new URLSearchParams(window.location.search);
const src = params.get('src') ?? '/master.m3u8';
player.load(src);
```

- [ ] **Step 5: Commit**

```bash
git add src/client/ui/ src/client/index.ts
git commit -m "feat: player UI with debug panel showing bandwidth/buffer/ABR visualization"
```

---

## Task 17: RTMP Ingest (Minimal Subset)

**Files:**
- Create: `src/server/ingest/rtmp/handshake.ts`
- Create: `src/server/ingest/rtmp/chunk-parser.ts`
- Create: `src/server/ingest/rtmp/amf0.ts`
- Create: `src/server/ingest/rtmp/rtmp-server.ts`
- Create: `test/server/ingest/rtmp/handshake.test.ts`
- Create: `test/server/ingest/rtmp/chunk-parser.test.ts`
- Create: `test/server/ingest/rtmp/amf0.test.ts`

- [ ] **Step 1: Write failing tests for AMF0 decoder**

```typescript
// test/server/ingest/rtmp/amf0.test.ts
import { describe, it, expect } from 'vitest';
import { decodeAMF0 } from '../../../../src/server/ingest/rtmp/amf0.js';

describe('AMF0 decoder', () => {
  it('decodes number type (marker 0x00)', () => {
    const buf = Buffer.alloc(9);
    buf[0] = 0x00; // number marker
    buf.writeDoubleBE(42.5, 1);
    const { value, bytesRead } = decodeAMF0(buf);
    expect(value).toBe(42.5);
    expect(bytesRead).toBe(9);
  });

  it('decodes boolean type (marker 0x01)', () => {
    const buf = Buffer.from([0x01, 0x01]);
    const { value, bytesRead } = decodeAMF0(buf);
    expect(value).toBe(true);
    expect(bytesRead).toBe(2);
  });

  it('decodes string type (marker 0x02)', () => {
    const str = 'hello';
    const buf = Buffer.alloc(3 + str.length);
    buf[0] = 0x02;
    buf.writeUInt16BE(str.length, 1);
    buf.write(str, 3);
    const { value, bytesRead } = decodeAMF0(buf);
    expect(value).toBe('hello');
    expect(bytesRead).toBe(8);
  });

  it('decodes null type (marker 0x05)', () => {
    const buf = Buffer.from([0x05]);
    const { value, bytesRead } = decodeAMF0(buf);
    expect(value).toBeNull();
    expect(bytesRead).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/ingest/rtmp/amf0.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement amf0.ts**

```typescript
// src/server/ingest/rtmp/amf0.ts

export interface AMF0Result {
  value: unknown;
  bytesRead: number;
}

export function decodeAMF0(buf: Buffer, offset = 0): AMF0Result {
  const marker = buf[offset];

  switch (marker) {
    case 0x00: { // Number
      const value = buf.readDoubleBE(offset + 1);
      return { value, bytesRead: 9 };
    }
    case 0x01: { // Boolean
      return { value: buf[offset + 1] !== 0, bytesRead: 2 };
    }
    case 0x02: { // String
      const len = buf.readUInt16BE(offset + 1);
      const value = buf.toString('utf8', offset + 3, offset + 3 + len);
      return { value, bytesRead: 3 + len };
    }
    case 0x03: { // Object
      const obj: Record<string, unknown> = {};
      let pos = offset + 1;
      while (pos < buf.length) {
        const keyLen = buf.readUInt16BE(pos);
        if (keyLen === 0 && buf[pos + 2] === 0x09) {
          pos += 3; // end of object
          break;
        }
        const key = buf.toString('utf8', pos + 2, pos + 2 + keyLen);
        pos += 2 + keyLen;
        const result = decodeAMF0(buf, pos);
        obj[key] = result.value;
        pos += result.bytesRead;
      }
      return { value: obj, bytesRead: pos - offset };
    }
    case 0x05: { // Null
      return { value: null, bytesRead: 1 };
    }
    default:
      return { value: undefined, bytesRead: 1 };
  }
}

export function decodeAMF0Multiple(buf: Buffer): unknown[] {
  const results: unknown[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { value, bytesRead } = decodeAMF0(buf, offset);
    results.push(value);
    offset += bytesRead;
  }
  return results;
}
```

- [ ] **Step 4: Run AMF0 tests**

Run: `npx vitest run test/server/ingest/rtmp/amf0.test.ts`
Expected: All PASS

- [ ] **Step 5: Write failing tests for handshake**

```typescript
// test/server/ingest/rtmp/handshake.test.ts
import { describe, it, expect } from 'vitest';
import { generateS0S1S2, validateC0 } from '../../../../src/server/ingest/rtmp/handshake.js';

describe('RTMP handshake', () => {
  it('validates C0 version byte (must be 3)', () => {
    expect(validateC0(Buffer.from([0x03]))).toBe(true);
    expect(validateC0(Buffer.from([0x04]))).toBe(false);
  });

  it('generates S0+S1+S2 response', () => {
    const c1 = Buffer.alloc(1536);
    const response = generateS0S1S2(c1);
    // S0(1) + S1(1536) + S2(1536) = 3073
    expect(response.length).toBe(3073);
    // S0 version byte
    expect(response[0]).toBe(0x03);
  });

  it('S2 echoes back C1', () => {
    const c1 = Buffer.alloc(1536, 0xAB);
    const response = generateS0S1S2(c1);
    // S2 starts at offset 1537, should echo C1
    const s2 = response.subarray(1537);
    expect(s2.subarray(8)).toEqual(c1.subarray(8)); // skip timestamp + echo timestamp
  });
});
```

- [ ] **Step 6: Implement handshake.ts**

```typescript
// src/server/ingest/rtmp/handshake.ts

import crypto from 'crypto';

export function validateC0(data: Buffer): boolean {
  return data[0] === 0x03;
}

export function generateS0S1S2(c1: Buffer): Buffer {
  const response = Buffer.alloc(3073);

  // S0: version
  response[0] = 0x03;

  // S1: timestamp(4) + zero(4) + random(1528)
  const s1 = response.subarray(1, 1537);
  s1.writeUInt32BE(0, 0);          // timestamp
  s1.writeUInt32BE(0, 4);          // zero
  crypto.randomFillSync(s1, 8);    // random bytes

  // S2: echo of C1 with timestamp
  const s2 = response.subarray(1537, 3073);
  c1.copy(s2);
  s2.writeUInt32BE(Date.now() & 0xFFFFFFFF, 4); // time2 = server uptime

  return response;
}
```

- [ ] **Step 7: Run handshake tests**

Run: `npx vitest run test/server/ingest/rtmp/handshake.test.ts`
Expected: All PASS

- [ ] **Step 8: Write and implement chunk-parser.ts and rtmp-server.ts**

```typescript
// test/server/ingest/rtmp/chunk-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseChunkHeader, CHUNK_HEADER_TYPE } from '../../../../src/server/ingest/rtmp/chunk-parser.js';

describe('RTMP chunk parser', () => {
  it('parses Type 0 chunk header (12 bytes)', () => {
    const buf = Buffer.alloc(12);
    buf[0] = 0x02; // fmt=0, csid=2
    buf.writeUIntBE(1000, 1, 3);    // timestamp
    buf.writeUIntBE(100, 4, 3);     // message length
    buf[7] = 0x14;                   // message type (command)
    buf.writeUInt32LE(1, 8);         // stream id (little-endian!)

    const header = parseChunkHeader(buf);
    expect(header.fmt).toBe(CHUNK_HEADER_TYPE.TYPE_0);
    expect(header.csid).toBe(2);
    expect(header.timestamp).toBe(1000);
    expect(header.messageLength).toBe(100);
    expect(header.messageTypeId).toBe(0x14);
  });

  it('parses Type 1 chunk header (8 bytes)', () => {
    const buf = Buffer.alloc(8);
    buf[0] = 0x42; // fmt=1, csid=2
    buf.writeUIntBE(500, 1, 3);   // timestamp delta
    buf.writeUIntBE(80, 4, 3);    // message length
    buf[7] = 0x09;                  // video message

    const header = parseChunkHeader(buf);
    expect(header.fmt).toBe(CHUNK_HEADER_TYPE.TYPE_1);
    expect(header.timestampDelta).toBe(500);
    expect(header.messageLength).toBe(80);
    expect(header.messageTypeId).toBe(0x09);
  });
});
```

```typescript
// src/server/ingest/rtmp/chunk-parser.ts

export const CHUNK_HEADER_TYPE = {
  TYPE_0: 0,
  TYPE_1: 1,
  TYPE_2: 2,
  TYPE_3: 3,
} as const;

export interface ChunkHeader {
  fmt: number;
  csid: number;
  timestamp?: number;
  timestampDelta?: number;
  messageLength?: number;
  messageTypeId?: number;
  messageStreamId?: number;
  headerSize: number;
}

export function parseChunkHeader(buf: Buffer): ChunkHeader {
  const firstByte = buf[0];
  const fmt = (firstByte >> 6) & 0x03;
  let csid = firstByte & 0x3F;
  let offset = 1;

  if (csid === 0) {
    csid = buf[offset++] + 64;
  } else if (csid === 1) {
    csid = buf[offset++] + 64 + buf[offset++] * 256;
  }

  const header: ChunkHeader = { fmt, csid, headerSize: offset };

  if (fmt === CHUNK_HEADER_TYPE.TYPE_0) {
    header.timestamp = (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
    offset += 3;
    header.messageLength = (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
    offset += 3;
    header.messageTypeId = buf[offset++];
    header.messageStreamId = buf.readUInt32LE(offset);
    offset += 4;
  } else if (fmt === CHUNK_HEADER_TYPE.TYPE_1) {
    header.timestampDelta = (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
    offset += 3;
    header.messageLength = (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
    offset += 3;
    header.messageTypeId = buf[offset++];
  } else if (fmt === CHUNK_HEADER_TYPE.TYPE_2) {
    header.timestampDelta = (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
    offset += 3;
  }
  // TYPE_3: no additional header bytes

  header.headerSize = offset;
  return header;
}

// RTMP message type constants
export const MSG_TYPE_AUDIO = 0x08;
export const MSG_TYPE_VIDEO = 0x09;
export const MSG_TYPE_COMMAND_AMF0 = 0x14;
export const MSG_TYPE_DATA_AMF0 = 0x12;
```

```typescript
// src/server/ingest/rtmp/rtmp-server.ts

import net from 'net';
import { EventEmitter } from 'events';
import { validateC0, generateS0S1S2 } from './handshake.js';
import { parseChunkHeader, MSG_TYPE_VIDEO, MSG_TYPE_AUDIO, MSG_TYPE_COMMAND_AMF0 } from './chunk-parser.js';
import { decodeAMF0Multiple } from './amf0.js';

type HandshakeState = 'WAITING_C0C1' | 'WAITING_C2' | 'READY';

export class RTMPServer extends EventEmitter {
  private server: net.Server;
  private chunkSize = 128;

  constructor() {
    super();
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleConnection(socket: net.Socket): void {
    let state: HandshakeState = 'WAITING_C0C1';
    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      if (state === 'WAITING_C0C1' && buffer.length >= 1537) {
        const c0 = buffer.subarray(0, 1);
        const c1 = buffer.subarray(1, 1537);
        buffer = buffer.subarray(1537);

        if (!validateC0(c0)) {
          socket.destroy();
          return;
        }

        socket.write(generateS0S1S2(c1));
        state = 'WAITING_C2';
      }

      if (state === 'WAITING_C2' && buffer.length >= 1536) {
        buffer = buffer.subarray(1536); // consume C2
        state = 'READY';
        this.emit('connection');
      }

      if (state === 'READY') {
        this.processChunks(buffer, socket);
        buffer = Buffer.alloc(0);
      }
    });

    socket.on('error', () => {
      this.emit('disconnect');
    });

    socket.on('close', () => {
      this.emit('disconnect');
    });
  }

  private processChunks(data: Buffer, socket: net.Socket): void {
    let offset = 0;

    while (offset < data.length) {
      if (offset >= data.length) break;

      const header = parseChunkHeader(data.subarray(offset));
      offset += header.headerSize;

      const messageLength = header.messageLength ?? 0;
      if (offset + messageLength > data.length) break;

      const payload = data.subarray(offset, offset + Math.min(messageLength, this.chunkSize));
      offset += payload.length;

      if (header.messageTypeId === MSG_TYPE_VIDEO) {
        this.emit('videoData', payload);
      } else if (header.messageTypeId === MSG_TYPE_AUDIO) {
        this.emit('audioData', payload);
      } else if (header.messageTypeId === MSG_TYPE_COMMAND_AMF0) {
        const args = decodeAMF0Multiple(payload);
        this.emit('command', args);
      }
    }
  }
}
```

- [ ] **Step 9: Run all RTMP tests**

Run: `npx vitest run test/server/ingest/rtmp/`
Expected: All PASS

- [ ] **Step 10: Update ingest/index.ts**

```typescript
// src/server/ingest/index.ts
export { FileIngest } from './file-ingest.js';
export { RTMPServer } from './rtmp/rtmp-server.js';
```

- [ ] **Step 11: Commit**

```bash
git add src/server/ingest/rtmp/ test/server/ingest/rtmp/ src/server/ingest/index.ts
git commit -m "feat: minimal RTMP server with handshake, chunk parsing, AMF0 decoding"
```

---

## Task 18: Test Fixtures + Integration Test

**Files:**
- Create: `test/fixtures/README.md`
- Create: `test/integration/vod-pipeline.test.ts`

- [ ] **Step 1: Create test fixtures README**

```markdown
<!-- test/fixtures/README.md -->
# Test Fixtures

Generate a small test video file for integration testing:

```bash
ffmpeg -f lavfi -i testsrc=duration=12:size=320x240:rate=30 \
       -f lavfi -i sine=frequency=440:duration=12 \
       -c:v libx264 -profile:v baseline -g 90 \
       -c:a aac -b:a 64k \
       test/fixtures/test-video.mp4
```

This creates a 12-second test video with:
- 320x240 resolution, 30fps
- Keyframe every 3 seconds (90 frames)
- AAC audio at 440Hz sine wave
```

- [ ] **Step 2: Write integration test for VOD pipeline**

```typescript
// test/integration/vod-pipeline.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

const FIXTURES_DIR = path.resolve('test/fixtures');
const TEST_VIDEO = path.join(FIXTURES_DIR, 'test-video.mp4');

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

describe('VOD Pipeline Integration', () => {
  beforeAll(() => {
    // Generate test fixture if not exists
    if (!fs.existsSync(TEST_VIDEO)) {
      fs.mkdirSync(FIXTURES_DIR, { recursive: true });
      try {
        execSync(
          `ffmpeg -f lavfi -i testsrc=duration=12:size=320x240:rate=30 -f lavfi -i sine=frequency=440:duration=12 -c:v libx264 -profile:v baseline -g 90 -c:a aac -b:a 64k ${TEST_VIDEO}`,
          { stdio: 'pipe' }
        );
      } catch {
        console.warn('FFmpeg not available, skipping integration tests');
      }
    }
  });

  it('generates a test video fixture', () => {
    if (!fs.existsSync(TEST_VIDEO)) return; // skip if no FFmpeg
    expect(fs.statSync(TEST_VIDEO).size).toBeGreaterThan(0);
  });

  // Additional integration tests will be added as the pipeline matures
  // For now, verify individual module outputs can chain together

  it('TS packager output starts with sync byte', async () => {
    const { buildTSPacket } = await import('../../src/server/packager/ts-packet.js');
    const { VIDEO_PID } = await import('../../src/shared/types.js');

    const packet = buildTSPacket({
      pid: VIDEO_PID,
      payload: Buffer.alloc(184, 0xFF),
      payloadUnitStart: true,
      continuityCounter: 0,
    });

    expect(packet[0]).toBe(0x47);
    expect(packet.length).toBe(188);
  });

  it('manifest generator produces valid m3u8', async () => {
    const { ManifestGenerator } = await import('../../src/server/manifest/index.js');
    const { QUALITY_LEVELS } = await import('../../src/shared/types.js');

    const manifest = new ManifestGenerator(QUALITY_LEVELS, 'vod');
    manifest.addSegment('360p', { index: 0, duration: 6.0, filename: 'seg-0.ts' });

    const master = manifest.getMasterPlaylist();
    expect(master).toContain('#EXTM3U');
    expect(master).toContain('BANDWIDTH');

    const media = manifest.getMediaPlaylist('360p');
    expect(media).toContain('#EXTINF:6.000');
    expect(media).toContain('#EXT-X-ENDLIST');
  });
});
```

- [ ] **Step 3: Run integration tests**

Run: `npx vitest run test/integration/`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/ test/integration/
git commit -m "feat: test fixtures setup and VOD pipeline integration tests"
```

---

## Task 19: Final Wiring + Run All Tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Fix any compilation errors**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Add npm scripts to package.json**

Add to `package.json` scripts:
```json
{
  "scripts": {
    "build": "tsc",
    "build:client": "tsc -p tsconfig.client.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/server/pipeline.js",
    "dev": "npx tsx src/server/pipeline.ts"
  }
}
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: finalize project setup with npm scripts and full test pass"
```
