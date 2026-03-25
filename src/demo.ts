/**
 * Ray-HLS Demo Server (파일 업로드 방식)
 *
 * Usage: npx tsx src/demo.ts
 *
 * 브라우저에서 영상 파일을 업로드하면 FFmpeg로 다중 비트레이트 HLS 세그먼트를
 * 생성한 뒤 MSE 기반 플레이어로 재생한다.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

const PORT = 8080;
const OUTPUT_DIR = path.resolve('demo-output');

const QUALITIES = [
  { name: '360p',  width: 640,  height: 360,  vBitrate: '800k',  aBitrate: '64k'  },
  { name: '480p',  width: 854,  height: 480,  vBitrate: '1400k', aBitrate: '96k'  },
  { name: '720p',  width: 1280, height: 720,  vBitrate: '2800k', aBitrate: '128k' },
  { name: '1080p', width: 1920, height: 1080, vBitrate: '5000k', aBitrate: '192k' },
];

// --- 초기 준비: 클라이언트 번들 + 정적 파일 ---
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

console.log('클라이언트 코드 번들링...');
execSync(
  `npx esbuild src/client/index.ts --bundle --format=esm --outfile=${OUTPUT_DIR}/player.js --sourcemap`,
  { stdio: 'pipe' }
);
fs.copyFileSync('src/client/ui/styles.css', path.join(OUTPUT_DIR, 'styles.css'));
console.log('번들 준비 완료');

// --- 업로드 페이지 HTML ---
const uploadPageHTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ray-HLS Player</title>
  <link rel="stylesheet" href="styles.css">
  <style>
    #upload-area {
      max-width: 960px;
      margin: 0 auto 24px auto;
      background: #16213e;
      border: 2px dashed #0f3460;
      border-radius: 8px;
      padding: 60px 40px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
    }
    #upload-area:hover, #upload-area.dragover {
      border-color: #e94560;
      background: #1a1a3e;
    }
    #upload-area h2 {
      color: #53d8fb;
      font-size: 20px;
      margin-bottom: 12px;
    }
    #upload-area p {
      color: #a0a0b0;
      font-size: 14px;
      margin-bottom: 16px;
    }
    #upload-area input[type="file"] { display: none; }
    #upload-btn {
      background: #e94560;
      color: #fff;
      border: none;
      padding: 10px 28px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.2s;
    }
    #upload-btn:hover { background: #c73652; }
    #progress-container {
      max-width: 960px;
      margin: 0 auto 24px auto;
      display: none;
    }
    #progress-bar-bg {
      background: #0f3460;
      border-radius: 4px;
      height: 8px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    #progress-bar {
      background: #53d8fb;
      height: 100%;
      width: 0%;
      transition: width 0.3s;
    }
    #progress-text {
      color: #a0a0b0;
      font-size: 13px;
      text-align: center;
    }
    #player-section { display: none; }
    #player-layout {
      display: flex;
      gap: 16px;
      max-width: 1400px;
      margin: 0 auto;
      align-items: flex-start;
    }
    #player-layout #player-container {
      flex: 1;
      min-width: 0;
      max-width: none;
      margin: 0;
    }
    #player-layout #debug-panel {
      width: 340px;
      flex-shrink: 0;
      max-width: none;
      margin: 0;
    }
    #player-layout #video {
      height: auto;
      aspect-ratio: 16/9;
    }
    #player-layout #stats {
      grid-template-columns: 1fr;
    }
    #player-layout #chart {
      max-width: 100%;
      width: 100%;
    }
    @media (max-width: 900px) {
      #player-layout {
        flex-direction: column;
      }
      #player-layout #debug-panel {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div id="upload-area">
    <h2>Ray-HLS Player</h2>
    <p>영상 파일을 드래그하거나 클릭하여 업로드하세요</p>
    <p style="font-size:12px; color:#666">MP4, MOV, MKV, AVI, WebM 지원</p>
    <button id="upload-btn">파일 선택</button>
    <input type="file" id="file-input" accept="video/*">
  </div>

  <div id="progress-container">
    <div id="progress-bar-bg"><div id="progress-bar"></div></div>
    <div id="progress-text">준비 중...</div>
  </div>

  <div id="player-section">
    <div id="player-layout">
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
          <label>Quality:
            <select id="quality-select">
              <option value="auto">Auto</option>
            </select>
          </label>
        </div>
      </div>
      <div id="debug-panel">
        <h3>Ray-HLS Debug Panel</h3>
        <div id="stats">
          <div>State: <span id="stat-state">IDLE</span></div>
          <div>Quality: <span id="stat-quality">-</span></div>
          <div>Bandwidth: <span id="stat-bandwidth">-</span></div>
          <div>Buffer: <span id="stat-buffer">-</span></div>
          <div>Strategy: <span id="stat-strategy">conservative</span></div>
          <div>Segment: <span id="stat-segment">-</span></div>
        </div>
        <canvas id="chart" width="400" height="200"></canvas>
      </div>
    </div>
  </div>

  <script type="module">
    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const playerSection = document.getElementById('player-section');

    uploadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    uploadArea.addEventListener('click', () => fileInput.click());

    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
    });

    async function handleFile(file) {
      uploadArea.style.display = 'none';
      progressContainer.style.display = 'block';
      progressText.textContent = '영상 업로드 중... (' + (file.size / 1048576).toFixed(1) + 'MB)';
      progressBar.style.width = '10%';

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 40);
          progressBar.style.width = pct + '%';
          progressText.textContent = '영상 업로드 중... ' + pct + '%';
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          progressBar.style.width = '40%';
          progressText.textContent = 'FFmpeg 트랜스코딩 중... (다소 시간이 걸립니다)';
          pollStatus();
        } else {
          progressText.textContent = '업로드 실패: ' + xhr.responseText;
        }
      });

      xhr.send(file);
    }

    async function pollStatus() {
      const interval = setInterval(async () => {
        try {
          const res = await fetch('/api/status');
          const data = await res.json();
          if (data.status === 'transcoding') {
            const pct = 40 + Math.round(data.progress * 55);
            progressBar.style.width = pct + '%';
            progressText.textContent = '트랜스코딩 중... ' + data.quality + ' (' + Math.round(data.progress * 100) + '%)';
          } else if (data.status === 'ready') {
            clearInterval(interval);
            progressBar.style.width = '100%';
            progressText.textContent = '완료! 재생을 시작합니다...';
            setTimeout(() => startPlayer(), 500);
          } else if (data.status === 'error') {
            clearInterval(interval);
            progressText.textContent = '트랜스코딩 실패: ' + (data.message || '');
          }
        } catch {}
      }, 1000);
    }

    async function startPlayer() {
      progressContainer.style.display = 'none';
      playerSection.style.display = 'block';

      const { HLSPlayer } = await import('./player.js');
      const { DebugPanel } = await import('./player.js');

      const video = document.getElementById('video');
      const player = new HLSPlayer(video);
      const debug = new DebugPanel('chart');

      const strategySelect = document.getElementById('abr-strategy');
      const qualitySelect = document.getElementById('quality-select');

      strategySelect.addEventListener('change', () => {
        try { player.abr.setStrategy(strategySelect.value); } catch {}
      });
      qualitySelect.addEventListener('change', () => {
        try {
          const v = qualitySelect.value;
          player.abr.lockQuality(v === 'auto' ? null : v);
        } catch {}
      });

      const populateQualities = setInterval(() => {
        try {
          const levels = player.abr.getQualityLevels();
          if (levels.length > 0 && qualitySelect.options.length <= 1) {
            for (const level of levels) {
              const opt = document.createElement('option');
              opt.value = level.name;
              opt.textContent = level.name + ' (' + level.width + 'x' + level.height + ')';
              qualitySelect.appendChild(opt);
            }
            clearInterval(populateQualities);
          }
        } catch {}
      }, 500);

      setInterval(() => {
        let strategy = '-';
        try { strategy = player.abr.currentStrategyName; } catch {}
        debug.update({
          state: player.state,
          quality: player.lastQuality || '-',
          bandwidth: player.lastBandwidth || 0,
          bufferLevel: player.lastBufferLevel || 0,
          strategy,
        });
      }, 1000);

      player.load('/master.m3u8');
    }
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), uploadPageHTML);

// --- 트랜스코딩 상태 관리 ---
let transcodeStatus: { status: string; progress: number; quality: string; message: string } = {
  status: 'idle', progress: 0, quality: '', message: '',
};

function transcodeVideo(inputPath: string): void {
  // 기존 HLS 파일 정리
  for (const q of QUALITIES) {
    const dir = path.join(OUTPUT_DIR, q.name);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  }

  // 세로 영상 감지
  let isPortrait = false;
  try {
    const probe = execSync(
      `ffprobe -v quiet -show_entries stream_side_data=rotation -of csv=p=0 "${inputPath}"`,
      { encoding: 'utf8' }
    ).trim();
    const rotMatch = probe.match(/-?\d+/);
    const rotation = rotMatch ? parseInt(rotMatch[0]) : 0;
    isPortrait = (Math.abs(rotation) === 90 || Math.abs(rotation) === 270);
    if (isPortrait) console.log(`세로 영상 감지 (rotation=${rotation})`);
  } catch {}

  transcodeStatus = { status: 'transcoding', progress: 0, quality: '', message: '' };

  // 동기식으로 순차 트랜스코딩 (백그라운드 실행)
  (async () => {
    try {
      for (let i = 0; i < QUALITIES.length; i++) {
        const q = QUALITIES[i];
        const dir = path.join(OUTPUT_DIR, q.name);
        fs.mkdirSync(dir, { recursive: true });

        const w = isPortrait ? q.height : q.width;
        const h = isPortrait ? q.width : q.height;

        transcodeStatus.quality = q.name;
        transcodeStatus.progress = i / QUALITIES.length;
        console.log(`  트랜스코딩: ${q.name}...`);

        const cmd = [
          'ffmpeg', '-y', '-i', `"${inputPath}"`,
          '-c:v', 'libx264', '-b:v', q.vBitrate,
          '-vf', `scale=${w}:${h}`,
          '-pix_fmt', 'yuv420p',
          '-profile:v', 'baseline',
          '-g', '90', '-keyint_min', '90', '-sc_threshold', '0',
          '-c:a', 'aac', '-b:a', q.aBitrate, '-ar', '44100', '-ac', '2',
          '-f', 'hls',
          '-hls_time', '3',
          '-hls_list_size', '0',
          '-hls_segment_filename', `"${path.join(dir, `${q.name}-seg-%d.ts`)}"`,
          `"${path.join(dir, 'playlist.m3u8')}"`,
        ].join(' ');

        execSync(cmd, { stdio: 'pipe' });
        console.log(`  ${q.name} 완료`);
      }

      // 마스터 플레이리스트 생성
      const masterPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '',
        ...QUALITIES.map(q => {
          const bw = parseInt(q.vBitrate) * 1000 + parseInt(q.aBitrate) * 1000;
          const resW = isPortrait ? q.height : q.width;
          const resH = isPortrait ? q.width : q.height;
          return [
            `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${resW}x${resH},CODECS="avc1.42c01e,mp4a.40.2"`,
            `${q.name}/playlist.m3u8`,
          ].join('\n');
        }),
      ].join('\n');
      fs.writeFileSync(path.join(OUTPUT_DIR, 'master.m3u8'), masterPlaylist);

      transcodeStatus = { status: 'ready', progress: 1, quality: '', message: '' };
      console.log('트랜스코딩 완료!');

      // 업로드된 임시 파일 삭제
      try { fs.unlinkSync(inputPath); } catch {}
    } catch (e: any) {
      console.error('트랜스코딩 실패:', e.message);
      transcodeStatus = { status: 'error', progress: 0, quality: '', message: e.message || '알 수 없는 오류' };
    }
  })();
}

// --- HTTP 서버 ---
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 파일 업로드
  if (req.method === 'POST' && req.url === '/api/upload') {
    const filename = decodeURIComponent(req.headers['x-filename'] as string || 'upload.mp4');
    const ext = path.extname(filename) || '.mp4';
    const tmpPath = path.join(OUTPUT_DIR, `_upload${ext}`);
    const ws = fs.createWriteStream(tmpPath);

    req.pipe(ws);
    ws.on('finish', () => {
      console.log(`업로드 완료: ${filename} (${(fs.statSync(tmpPath).size / 1048576).toFixed(1)}MB)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      transcodeVideo(tmpPath);
    });
    ws.on('error', (err) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // 트랜스코딩 상태 조회
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(transcodeStatus));
    return;
  }

  // 대역폭 리포트
  if (req.method === 'POST' && req.url === '/api/bandwidth') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const report = JSON.parse(body);
        console.log(`  [bandwidth] bw=${(report.measuredBandwidth / 1e6).toFixed(1)}Mbps quality=${report.currentQuality} buffer=${report.bufferLevel?.toFixed(1)}s`);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ack":true}');
    });
    return;
  }

  // 정적 파일 서빙
  let url = req.url || '/';
  if (url === '/') url = '/index.html';

  const filePath = path.join(OUTPUT_DIR, url);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);

  const range = req.headers.range;
  if (range && ext === '.ts') {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : data.length - 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': end - start + 1,
    });
    res.end(data.subarray(start, end + 1));
  } else {
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
    res.end(data);
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('====================================');
  console.log('  Ray-HLS Demo Server');
  console.log(`  http://localhost:${PORT}`);
  console.log('====================================');
  console.log('');
  console.log('브라우저에서 영상 파일을 업로드하세요.');
});
