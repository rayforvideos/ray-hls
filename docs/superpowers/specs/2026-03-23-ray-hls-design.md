# Ray-HLS Design Spec

## Overview

Node.js 기반 커스텀 HLS 스트리밍 시스템. 학습 목적으로 HLS 프로토콜을 밑바닥부터 구현하되, 비디오 인코딩만 FFmpeg에 위임한다. 기존 HLS 대비 두 가지 차별화 포인트를 포함한다:

1. **플러그인 방식 ABR 전략 엔진** — 어댑티브 비트레이트 전환 로직을 런타임에 교체 가능
2. **프리페칭 엔진** — 시청 패턴 분석 기반 세그먼트 예측 프리로드

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
| Transcoder | FFmpeg child process로 멀티 비트레이트 인코딩 (360p/480p/720p/1080p) |
| TS Packager | 인코딩된 raw H.264를 MPEG-TS 컨테이너로 직접 패키징 |
| Manifest Generator | master/variant m3u8 플레이리스트 생성 및 업데이트 |
| HTTP Server | m3u8 + .ts 세그먼트 서빙, 클라이언트 대역폭 리포트 수신 |
| Custom Player | MSE API로 TS 디먹싱 -> fMP4 리먹싱 -> 재생, ABR + 프리페칭 내장 |

## Server Side Detail

### Ingest Module

- **File mode**: 로컬 경로를 받아 파일 스트림으로 읽기
- **Live mode**: RTMP 핸드셰이크, 청크 파싱을 직접 구현한 TCP 서버 (net 모듈). AMF0 디코딩으로 메타데이터 추출

### Transcoder

- FFmpeg를 child_process.spawn으로 실행
- 입력 하나에서 멀티 비트레이트 출력 (360p/480p/720p/1080p)
- 각 품질별로 raw H.264 NAL unit 스트림을 pipe로 받음
- 세그먼트 길이(기본 6초)를 키프레임 간격으로 제어

### TS Packager

- H.264 NAL unit -> PES 패킷 -> TS 패킷(188바이트) 변환을 직접 구현
- PAT/PMT 테이블 생성
- PCR/PTS/DTS 타임스탬프 계산
- 세그먼트 경계에서 파일로 flush

### Manifest Generator

- **Master playlist**: 각 품질별 variant 스트림 나열 (BANDWIDTH, RESOLUTION 태그)
- **Media playlist**: 세그먼트 목록, EXTINF 태그, 시퀀스 번호 관리
- 라이브 모드: 슬라이딩 윈도우 방식으로 오래된 세그먼트 제거
- VOD 모드: EXT-X-ENDLIST 포함

### HTTP Server

- Express 없이 `http` 모듈로 직접 구현
- `GET /*.m3u8` — 매니페스트 서빙
- `GET /*.ts` — 세그먼트 서빙 (Range 요청 지원)
- `POST /api/bandwidth` — 클라이언트가 측정한 대역폭 리포트 수신

## Client Side Detail

### Custom Player (MSE)

**TS Demuxer**
- 브라우저에서 받은 .ts 세그먼트를 188바이트 단위로 파싱
- PAT/PMT 해석 -> PES 추출 -> H.264 NAL unit 분리
- JavaScript로 직접 구현

**fMP4 Remuxer**
- MSE는 TS를 직접 못 먹으므로, H.264 데이터를 fragmented MP4로 재패키징
- ftyp, moov(초기화), moof+mdat(세그먼트) 박스를 바이트 레벨로 직접 생성

**Playback Control**
- MediaSource + SourceBuffer API로 세그먼트를 순차 append
- 버퍼 관리: 재생 위치 기준 앞뒤 일정 범위만 유지, 나머지 remove

### ABR Strategy Engine (Differentiator 1)

전략을 플러그인으로 교체 가능한 구조:

```
Strategy Interface:
- name: string
- decide(context): QualityLevel

Context:
- bandwidth: number (최근 측정 대역폭)
- bufferLevel: number (현재 버퍼 잔량, 초)
- history: Measurement[] (과거 N개 세그먼트 다운로드 기록)
- qualityLevels: QualityLevel[]
```

기본 제공 전략 3가지:

| Strategy | Logic |
|----------|-------|
| Conservative | 대역폭의 70%만 사용, 버퍼링 최소화 우선 |
| Aggressive | 가능한 최고 품질, 버퍼가 낮아질 때만 다운 |
| Smooth | 급격한 품질 변화 방지, 한 단계씩만 전환 |

웹 UI에서 전략을 실시간 전환 가능. 각 전략의 판단 과정을 시각적으로 비교하는 디버그 패널 포함.

### Prefetch Engine (Differentiator 2)

시청 패턴 분석 -> 다음 세그먼트 예측 프리로드:

- 현재 재생 속도, 버퍼 소비율, 대역폭 추이를 기반으로 다음에 필요할 세그먼트 예측
- 유휴 대역폭 존재 시 다음 품질 레벨의 세그먼트까지 미리 로드
- 서버에 대역폭 리포트를 보내서, 서버가 세그먼트를 선제적으로 준비

프리페칭 전략:
- **Buffer-ahead**: 항상 N초 분량을 미리 확보
- **Quality-upgrade**: 현재 품질보다 한 단계 높은 세그먼트를 백그라운드로 로드, 대역폭 여유 시 교체
- 서버 측 `/api/bandwidth` 엔드포인트와 연동

## Data Flow

### VOD Flow
```
파일 경로 입력 -> Ingest(파일 읽기) -> Transcoder(4개 품질 인코딩)
-> TS Packager(세그먼트 생성) -> Manifest Generator(m3u8 완성, EXT-X-ENDLIST)
-> HTTP Server 서빙 대기
```

### Live Flow
```
RTMP 클라이언트 연결 -> Ingest(RTMP 파싱) -> Transcoder(실시간 인코딩)
-> TS Packager(세그먼트 생성, 실시간 flush) -> Manifest Generator(슬라이딩 윈도우 업데이트)
-> HTTP Server 즉시 서빙
```

## Error Handling

- **FFmpeg 크래시**: 자동 재시작, 마지막 키프레임부터 재개
- **RTMP 연결 끊김**: 매니페스트에 EXT-X-ENDLIST 추가하여 정상 종료
- **세그먼트 404**: 클라이언트가 매니페스트 재요청 -> 최신 세그먼트 목록으로 복구
- **버퍼 언더런**: ABR 엔진이 최저 품질로 전환, 회복 후 점진적 상향

## Project Structure

```
ray-hls/
├── src/
│   ├── server/
│   │   ├── ingest/         # 파일 읽기 + RTMP 서버
│   │   ├── transcoder/     # FFmpeg 래퍼
│   │   ├── packager/       # TS 패키징
│   │   ├── manifest/       # m3u8 생성
│   │   └── http/           # HTTP 서버
│   ├── client/
│   │   ├── player/         # MSE 플레이어
│   │   ├── demuxer/        # TS 디먹서
│   │   ├── remuxer/        # fMP4 리먹서
│   │   ├── abr/            # ABR 전략 엔진
│   │   └── prefetch/       # 프리페칭 엔진
│   └── shared/             # 공통 상수, 타입
├── test/
├── docs/
├── package.json
└── README.md
```

## Testing Strategy

- **Unit tests**: TS 패키징, m3u8 생성, ABR 전략 판단 로직 등 순수 로직
- **Integration tests**: 파일 입력 -> 세그먼트 생성 -> HTTP 서빙 -> 플레이어 재생 E2E
- **Manual tests**: 브라우저에서 실제 영상 재생, ABR 전략 전환 확인
