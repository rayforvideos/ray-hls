# Ray-HLS Design Spec

## Overview

Node.js (TypeScript) 기반 커스텀 HLS 스트리밍 시스템. 학습 목적으로 HLS 프로토콜을 밑바닥부터 구현하되, 비디오/오디오 인코딩만 FFmpeg에 위임한다. 기존 HLS 대비 두 가지 차별화 포인트를 포함한다:

1. **플러그인 방식 ABR 전략 엔진** — 어댑티브 비트레이트 전환 로직을 런타임에 교체 가능
2. **프리페칭 엔진** — 시청 패턴 분석 기반 세그먼트 예측 프리로드

## Scope & Non-Goals

**In Scope:**
- H.264 비디오 + AAC 오디오 처리 (인코딩은 FFmpeg, 패키징/디먹싱은 직접 구현)
- VOD (로컬 파일) + 라이브 (RTMP) 입력
- TS 패키징, m3u8 매니페스트 생성, HTTP 서빙 전부 직접 구현
- MSE 기반 커스텀 플레이어 (TS 디먹싱, fMP4 리먹싱 직접 구현)
- 플러그인 ABR 전략 엔진, 프리페칭 엔진

**Non-Goals (v1):**
- 자막/캡션 트랙
- DRM/암호화
- 멀티 클라이언트 부하 최적화 (학습용이므로 단일 클라이언트 기준)

**Stretch Goals (시간이 허락하면):**
- Quality-upgrade 프리페칭 전략 (MSE SourceBuffer 교체 복잡성이 높음)
- RTMP 전체 스펙 구현 (v1은 최소 서브셋)

## Architecture

```
[입력 소스]          [서버 파이프라인]              [클라이언트]

MP4/MKV --> Ingest --> FFmpeg  --> TS Packager --> HTTP Server --> Custom Player
RTMP    --> Module    (encode)    (세그먼트화)    (m3u8+.ts)     (MSE 기반)
                                      |                              |
                                      v                              v
                                 Manifest        <-----------  ABR Strategy
                                 Generator        bandwidth    Engine
                                 (m3u8 생성)      report       (품질 전환)
                                                                     |
                                                                     v
                                                               Prefetch
                                                               Engine
                                                               (예측 프리로드)
```

### 6 Core Modules

| Module | Responsibility |
|--------|---------------|
| Ingest | 로컬 파일 읽기 + RTMP 서버로 라이브 스트림 수신 |
| Transcoder | FFmpeg child process로 멀티 비트레이트 인코딩 (360p/480p/720p/1080p), H.264 + AAC 출력 |
| TS Packager | 인코딩된 H.264 + AAC를 MPEG-TS 컨테이너로 직접 패키징 |
| Manifest Generator | master/variant m3u8 플레이리스트 생성 및 업데이트 |
| HTTP Server | m3u8 + .ts 세그먼트 서빙, CORS 헤더 처리, 대역폭 리포트 수신 |
| Custom Player | MSE API로 TS 디먹싱 -> fMP4 리먹싱 -> 재생, ABR + 프리페칭 내장 |

## Server Side Detail

### Ingest Module

- **File mode**: 로컬 경로를 받아 파일 스트림으로 읽기
- **Live mode (RTMP minimal subset)**:
  - C0/C1/C2, S0/S1/S2 핸드셰이크
  - 청크 스트림 파싱 (고정 청크 사이즈, 단일 스트림)
  - 비디오(H.264) + 오디오(AAC) 메시지 분리
  - AMF0 디코딩으로 메타데이터 추출
  - 제한: 단일 publish 스트림만 수용, 인증 없음, flow control 미구현

### Transcoder

- 품질 레벨당 별도의 FFmpeg child_process.spawn 실행 (총 4개 프로세스)
- 입력: Ingest로부터 받은 원본 스트림 (파일 경로 또는 pipe)
- 출력: `-f h264` (Annex B 바이트스트림) + `-f adts` (AAC ADTS 프레임)
- 각 프로세스는 비디오/오디오를 별도 named pipe (또는 임시 파일 디스크립터)로 출력
- 키프레임 간격: `-g 180` (30fps 기준 6초) — 세그먼트 경계 결정
- 품질 프리셋:

| Level | Resolution | Video Bitrate | Audio Bitrate |
|-------|-----------|---------------|---------------|
| 360p  | 640x360   | 800kbps       | 64kbps        |
| 480p  | 854x480   | 1400kbps      | 96kbps        |
| 720p  | 1280x720  | 2800kbps      | 128kbps       |
| 1080p | 1920x1080 | 5000kbps      | 192kbps       |

### TS Packager

- **세그먼트 경계 감지**: H.264 스트림에서 IDR NAL unit (type 5) 감지 시 새 세그먼트 시작
- **비디오**: H.264 NAL unit (Annex B) -> PES 패킷 -> TS 패킷(188바이트)
- **오디오**: AAC ADTS 프레임 -> PES 패킷 -> TS 패킷(188바이트)
- PAT 테이블: program 0 -> PMT PID
- PMT 테이블: video stream (PID 0x100, stream type 0x1B H.264) + audio stream (PID 0x101, stream type 0x0F AAC)
- PCR은 비디오 PES의 PTS 기반으로 계산
- PTS/DTS 타임스탬프: 90kHz 클록 기준
- 세그먼트 경계(IDR 감지)에서 파일로 flush, Manifest Generator에 알림

### Manifest Generator

- **Master playlist**: 각 품질별 variant 스트림 나열 (BANDWIDTH, RESOLUTION, CODECS 태그)
- **Media playlist**: 세그먼트 목록, EXTINF 태그 (실제 세그먼트 duration), 시퀀스 번호 관리
- 라이브 모드: 슬라이딩 윈도우 방식으로 오래된 세그먼트 제거 (최근 5개 유지)
- VOD 모드: EXT-X-ENDLIST 포함
- 세그먼트 duration 기본값 6초. 트레이드오프: 짧을수록(2-4s) 라이브 레이턴시와 ABR 반응성 향상, 길수록(6-10s) HTTP 오버헤드 감소

### HTTP Server

- Express 없이 `http` 모듈로 직접 구현
- **CORS**: 모든 응답에 `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` 헤더 포함. OPTIONS preflight 처리
- `GET /*.m3u8` — 매니페스트 서빙 (Content-Type: application/vnd.apple.mpegurl)
- `GET /*.ts` — 세그먼트 서빙 (Content-Type: video/mp2t, Range 요청 지원)
- `POST /api/bandwidth` — 클라이언트 대역폭 리포트 수신

**`/api/bandwidth` API 스키마:**

```
POST /api/bandwidth
Content-Type: application/json

Request:
{
  "clientId": string,        // 클라이언트 고유 ID (플레이어 초기화 시 생성)
  "measuredBandwidth": number, // bps 단위 측정 대역폭
  "currentQuality": string,  // 현재 재생 중인 품질 레벨
  "bufferLevel": number      // 현재 버퍼 잔량 (초)
}

Response:
{
  "ack": true
}
```

서버는 이 데이터를 로깅하여 디버그 대시보드에서 클라이언트 상태를 모니터링하는 용도로 사용. 서버 측에서 세그먼트 생성이나 전송을 변경하지는 않음 (프리페칭은 순수 클라이언트 사이드 로직).

## Client Side Detail

### Custom Player (MSE)

**TS Demuxer**
- 브라우저에서 받은 .ts 세그먼트를 188바이트 단위로 파싱
- PAT/PMT 해석 -> 비디오 PID, 오디오 PID 식별
- PES 추출 -> H.264 NAL unit 분리 + AAC ADTS 프레임 분리
- JavaScript로 직접 구현 (Uint8Array/DataView 활용)

**fMP4 Remuxer**
- MSE는 TS를 직접 못 먹으므로, H.264 + AAC 데이터를 fragmented MP4로 재패키징
- 초기화 세그먼트: ftyp + moov (trak for video + trak for audio)
- 미디어 세그먼트: moof + mdat (비디오/오디오 샘플 인터리빙)
- 바이트 레벨로 MP4 박스 직접 생성
- 품질 전환 시 새로운 moov(초기화 세그먼트) 재생성 필요

**Playback Control & State Machine**
- MediaSource + SourceBuffer API로 세그먼트를 순차 append
- SourceBuffer 2개: 비디오용 + 오디오용
- 버퍼 관리: 재생 위치 기준 앞으로 30초, 뒤로 10초 유지. 범위 밖 데이터 remove
- 상태 머신:

```
IDLE -> LOADING_MANIFEST -> LOADING_INIT_SEGMENT -> BUFFERING -> PLAYING -> ENDED
                                                       ^    |
                                                       |    v
                                                    REBUFFERING
```

- 에러 처리:
  - `QuotaExceededError`: 오래된 버퍼 데이터 즉시 remove 후 재시도
  - `updateend` 이벤트 기반 순차 append (동시 append 방지)
  - `sourceended`/`sourceclose`: 정리 및 상태 리셋
  - 품질 전환 시: SourceBuffer.changeType() 또는 새 초기화 세그먼트 append
  - seek: 버퍼 범위 확인 후 필요 시 해당 위치 세그먼트 로드

### ABR Strategy Engine (Differentiator 1)

전략을 플러그인으로 교체 가능한 구조:

```
Strategy Interface:
- name: string
- decide(context): QualityLevel

Context:
- bandwidth: number (최근 측정 대역폭, bps)
- bufferLevel: number (현재 버퍼 잔량, 초)
- history: Measurement[] (과거 10개 세그먼트의 다운로드 기록)
- qualityLevels: QualityLevel[]
- currentQuality: QualityLevel

Measurement:
- segmentUrl: string
- byteSize: number
- downloadTimeMs: number
- quality: QualityLevel
```

기본 제공 전략 3가지:

| Strategy | Logic |
|----------|-------|
| Conservative | 대역폭의 70%만 사용, 버퍼링 최소화 우선 |
| Aggressive | 가능한 최고 품질, 버퍼가 낮아질 때만 다운 |
| Smooth | 급격한 품질 변화 방지, 한 단계씩만 전환 |

웹 UI에서 전략을 실시간 전환 가능. 디버그 패널에서 시간축 기반 그래프로 대역폭 추이, 선택된 품질 레벨, 버퍼 레벨을 시각화.

### Prefetch Engine (Differentiator 2)

순수 클라이언트 사이드 프리페칭:

- 현재 재생 속도, 버퍼 소비율, 대역폭 추이를 기반으로 다음에 필요할 세그먼트 예측
- 유휴 대역폭 존재 시 현재 품질의 다음 세그먼트를 미리 로드

**Buffer-ahead 전략:**
- 목표: 항상 버퍼 관리 임계값(30초) 근처까지 세그먼트 확보
- 현재 버퍼가 목표치 미만이면 다음 세그먼트 즉시 fetch
- 대역폭 여유분 계산: (측정 대역폭 - 현재 품질 비트레이트) > 0이면 프리페치 활성

**Quality-upgrade 전략 (stretch goal):**
- 현재 품질보다 한 단계 높은 세그먼트를 백그라운드로 로드
- SourceBuffer에 이미 append된 데이터는 교체 불가하므로, 아직 재생 전인 구간만 대상
- 해당 구간 remove -> 더 높은 품질 세그먼트 append
- 복잡성이 높아 stretch goal로 분류

서버 측 `/api/bandwidth`는 모니터링/디버깅 용도로만 사용.

## Data Flow

### VOD Flow
```
파일 경로 입력 -> Ingest(파일 읽기) -> Transcoder(4개 품질 x H.264+AAC 인코딩)
-> TS Packager(비디오+오디오 먹싱, 세그먼트 생성) -> Manifest Generator(m3u8 완성, EXT-X-ENDLIST)
-> HTTP Server 서빙 대기
```

### Live Flow
```
RTMP 클라이언트 연결 -> Ingest(RTMP 파싱, H.264+AAC 분리)
-> Transcoder(실시간 인코딩) -> TS Packager(세그먼트 생성, 실시간 flush)
-> Manifest Generator(슬라이딩 윈도우 업데이트) -> HTTP Server 즉시 서빙
```

## Error Handling

### Server Side
- **FFmpeg 크래시**: 자동 재시작, 마지막 키프레임부터 재개
- **RTMP 연결 끊김**: 매니페스트에 EXT-X-ENDLIST 추가하여 정상 종료
- **잘못된 입력 파일**: 에러 로그 + 클라이언트에 HTTP 500 응답

### Client Side
- **세그먼트 404**: 매니페스트 재요청 -> 최신 세그먼트 목록으로 복구
- **버퍼 언더런**: 상태를 REBUFFERING으로 전환, ABR 엔진이 최저 품질로 전환, 회복 후 점진적 상향
- **QuotaExceededError**: 오래된 버퍼 제거 후 재시도
- **네트워크 타임아웃**: 3회 재시도 후 실패 시 에러 표시
- **코덱 전환 실패**: 이전 품질로 롤백

## Project Structure

```
ray-hls/
├── src/
│   ├── server/
│   │   ├── ingest/         # 파일 읽기 + RTMP 서버
│   │   ├── transcoder/     # FFmpeg 래퍼
│   │   ├── packager/       # TS 패키징 (비디오+오디오)
│   │   ├── manifest/       # m3u8 생성
│   │   └── http/           # HTTP 서버 (CORS 포함)
│   ├── client/
│   │   ├── player/         # MSE 플레이어 + 상태 머신
│   │   ├── demuxer/        # TS 디먹서 (비디오+오디오)
│   │   ├── remuxer/        # fMP4 리먹서 (비디오+오디오)
│   │   ├── abr/            # ABR 전략 엔진
│   │   └── prefetch/       # 프리페칭 엔진
│   └── shared/             # 공통 상수, 타입
├── test/
├── docs/
├── package.json
├── tsconfig.json
└── README.md
```

## Testing Strategy

- **Framework**: Vitest
- **Unit tests**: TS 패키징 (FFmpeg 생성 TS와 바이트 비교 검증), m3u8 생성, ABR 전략 판단 로직, fMP4 박스 생성
- **Integration tests**: 파일 입력 -> 세그먼트 생성 -> HTTP 서빙 파이프라인
- **E2E tests**: Playwright로 브라우저에서 실제 영상 재생, ABR 전략 전환 확인
- **Manual tests**: 디버그 대시보드 시각적 확인
