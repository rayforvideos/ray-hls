# Ray-HLS

밑바닥부터 만든 커스텀 HLS 스트리밍 시스템. Node.js/TypeScript 기반.

기존 HLS 라이브러리(hls.js 등)를 사용하지 않고, TS 디먹싱 → fMP4 리먹싱 → MSE 재생까지 전체 파이프라인을 직접 구현했습니다.

## 기존 HLS와 다른 점

### 1. 플러그인 방식 ABR 전략 엔진

기존 HLS 플레이어는 ABR(Adaptive Bitrate) 로직이 하드코딩되어 있습니다. Ray-HLS는 전략을 **런타임에 교체**할 수 있습니다.

```typescript
interface ABRStrategy {
  name: string;
  decide(context: ABRContext): QualityLevel;
}
```

기본 제공 3가지 전략:

| 전략 | 동작 |
|------|------|
| **Conservative** | 대역폭의 70%만 사용. 버퍼링 최소화 |
| **Aggressive** | 대역폭 100% 사용. 최고 화질 우선 |
| **Smooth** | 한 단계씩만 전환. 급격한 화질 변화 방지 |

커스텀 전략을 만들어서 `abrEngine.registerStrategy(myStrategy)`로 등록할 수 있습니다.

### 2. 프리페칭 엔진

시청 패턴과 버퍼 상태를 분석해서 다음 세그먼트를 예측 프리로드합니다. 현재 버퍼가 목표치(30초) 미만이면 유휴 대역폭을 활용해 미리 세그먼트를 로드합니다.

### 3. 수동 품질 선택

Auto(ABR 자동) 외에 360p/480p/720p/1080p 수동 선택이 가능합니다. 품질 전환 시 새로운 init segment를 자동으로 생성해서 MSE에 append합니다.

### 4. 실시간 디버그 패널

재생 중 ABR 판단 과정을 시각적으로 확인할 수 있습니다:
- 현재 상태 (PLAYING, BUFFERING, ENDED 등)
- 선택된 품질 레벨
- 측정된 대역폭
- 버퍼 잔량
- ABR 전략
- 시간축 그래프 (대역폭 추이, 버퍼 레벨)

### 5. 전체 파이프라인 직접 구현

| 모듈 | 기존 HLS | Ray-HLS |
|------|----------|---------|
| TS 패키징 | FFmpeg/라이브러리 | 188바이트 패킷 직접 생성 (PAT/PMT/PES) |
| m3u8 매니페스트 | 라이브러리 | 직접 생성 (master/media playlist) |
| TS 디먹싱 | hls.js 등 | 브라우저에서 직접 파싱 (Uint8Array) |
| fMP4 리먹싱 | transmuxer 라이브러리 | 바이트 레벨로 ftyp/moov/moof/mdat 직접 생성 |
| MSE 재생 | hls.js 등 | MediaSource + SourceBuffer 직접 제어 |
| RTMP 수신 | node-media-server 등 | 핸드셰이크/청크파싱/AMF0 직접 구현 |

## 아키텍처

```
[입력]               [서버]                    [클라이언트]

MP4/MKV ─→ Ingest ─→ FFmpeg ─→ TS Packager ─→ HTTP Server ─→ Custom Player
RTMP    ─→          (encode)   (세그먼트화)    (m3u8+.ts)     (MSE 기반)
                                    │                             │
                                    ▼                             ▼
                              Manifest Gen     ←──────────  ABR Strategy
                              (m3u8 생성)       bandwidth    Engine
                                                report       │
                                                             ▼
                                                       Prefetch Engine
```

### 서버 모듈 (6개)

- **Ingest** — 로컬 파일 읽기 + RTMP 서버 (핸드셰이크, 청크 파싱, AMF0)
- **Transcoder** — FFmpeg child process로 멀티 비트레이트 인코딩
- **TS Packager** — H.264 NAL → PES → 188바이트 TS 패킷 변환, PAT/PMT 생성, IDR 감지로 세그먼트 분할
- **Manifest Generator** — master/media m3u8 생성 (VOD + 라이브 슬라이딩 윈도우)
- **HTTP Server** — CORS, Range 요청, 대역폭 리포트 API
- **Pipeline** — 전체 서버 모듈 배선

### 클라이언트 모듈 (6개)

- **TS Demuxer** — TS 패킷 파싱, PAT/PMT 해석, PES 추출, PTS/DTS 디코딩
- **fMP4 Remuxer** — Annex B→AVCC 변환, ADTS 헤더 제거, fMP4 박스 생성 (ftyp/moov/moof/mdat)
- **ABR Engine** — 플러그인 전략, 대역폭 측정, 수동 품질 잠금
- **Prefetch Engine** — Buffer-ahead 프리페칭
- **HLS Player** — MSE 상태 머신, SourceBuffer 큐 관리, 품질 전환 시 init segment 재생성
- **Debug Panel** — 실시간 통계 + Canvas 그래프

## 빠른 시작

### 필요 조건

- Node.js 18+
- FFmpeg

### 설치

```bash
git clone <repo>
cd ray-hls
npm install
```

### 테스트

```bash
npm test          # 278개 유닛 테스트
npm run test:watch  # 워치 모드
```

### 데모 실행

```bash
npx tsx src/demo.ts path/to/video.mp4
```

`http://localhost:8080`에서 플레이어가 열립니다.

- 세로 영상(폰 촬영) 자동 감지
- 360p / 480p / 720p / 1080p 4개 품질 자동 생성
- ABR 전략 실시간 전환
- 수동 품질 선택

### 프로젝트 구조

```
src/
├── server/
│   ├── packager/      # TS 패킷, PES, PAT/PMT, 세그멘터
│   ├── manifest/      # m3u8 생성
│   ├── transcoder/    # FFmpeg 래퍼
│   ├── ingest/        # 파일 읽기 + RTMP 서버
│   ├── http/          # HTTP 서버
│   └── pipeline.ts    # 서버 오케스트레이터
├── client/
│   ├── demuxer/       # TS 디먹서 + NAL 파서
│   ├── remuxer/       # fMP4 박스 빌더 + 샘플 변환
│   ├── abr/           # ABR 전략 엔진
│   ├── prefetch/      # 프리페칭 엔진
│   ├── player/        # MSE 플레이어 + 상태 머신
│   └── ui/            # 디버그 패널 + 스타일
├── shared/
│   └── types.ts       # 공통 타입, 상수
└── demo.ts            # 데모 서버
```

## 기술 스택

- **언어**: TypeScript
- **서버**: Node.js (http, net, child_process)
- **클라이언트**: Vanilla JS + MSE API + Canvas
- **인코딩**: FFmpeg (외부 의존성)
- **테스트**: Vitest (유닛), Playwright (E2E)
- **번들링**: esbuild

## 수치

- 소스 파일: 38개
- 소스 코드: ~4,300줄
- 테스트: 278개 (23 파일)
- 커밋: 30+
