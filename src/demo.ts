/**
 * Ray-HLS Demo Server
 *
 * Usage: npx tsx src/demo.ts [path-to-video]
 *
 * 1. Uses FFmpeg to generate multi-bitrate HLS segments
 * 2. Bundles client code with esbuild
 * 3. Serves everything on http://localhost:8080
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

const PORT = 8080;
const OUTPUT_DIR = path.resolve('demo-output');
const INPUT_FILE = process.argv[2] || 'test/fixtures/test-video.mp4';

if (!fs.existsSync(INPUT_FILE)) {
  console.error(`Input file not found: ${INPUT_FILE}`);
  process.exit(1);
}

// Quality presets matching our shared types
const QUALITIES = [
  { name: '360p',  width: 640,  height: 360,  vBitrate: '800k',  aBitrate: '64k'  },
  { name: '480p',  width: 854,  height: 480,  vBitrate: '1400k', aBitrate: '96k'  },
  { name: '720p',  width: 1280, height: 720,  vBitrate: '2800k', aBitrate: '128k' },
  { name: '1080p', width: 1920, height: 1080, vBitrate: '5000k', aBitrate: '192k' },
];

// Detect if video is portrait (rotated) by checking rotation metadata
let isPortrait = false;
try {
  const probe = execSync(
    `ffprobe -v quiet -show_entries stream_side_data=rotation -of csv=p=0 "${INPUT_FILE}"`,
    { encoding: 'utf8' }
  ).trim();
  // Output may be ",−90" or "−90" — extract the number
  const rotMatch = probe.match(/-?\d+/);
  const rotation = rotMatch ? parseInt(rotMatch[0]) : 0;
  isPortrait = (Math.abs(rotation) === 90 || Math.abs(rotation) === 270);
  if (isPortrait) console.log(`Detected portrait video (rotation=${rotation})`);
} catch {}

// Step 1: Generate HLS segments with FFmpeg
console.log('Generating HLS segments with FFmpeg...');

for (const q of QUALITIES) {
  const dir = path.join(OUTPUT_DIR, q.name);
  fs.mkdirSync(dir, { recursive: true });

  // For portrait video, swap width/height so aspect ratio is preserved
  const w = isPortrait ? q.height : q.width;
  const h = isPortrait ? q.width : q.height;

  const cmd = [
    'ffmpeg', '-y', '-i', INPUT_FILE,
    '-c:v', 'libx264', '-b:v', q.vBitrate,
    '-vf', `scale=${w}:${h}`,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',
    '-g', '90', '-keyint_min', '90', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', q.aBitrate, '-ar', '44100', '-ac', '2',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_list_size', '0',
    '-hls_segment_filename', path.join(dir, `${q.name}-seg-%d.ts`),
    path.join(dir, 'playlist.m3u8'),
  ].join(' ');

  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log(`  ${q.name} done`);
  } catch (e: any) {
    console.error(`  ${q.name} failed:`, e.stderr?.toString().slice(-200));
    process.exit(1);
  }
}

// Generate master playlist
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
console.log('Master playlist generated');

// Step 2: Bundle client code
console.log('Bundling client code...');
execSync(
  `npx esbuild src/client/index.ts --bundle --format=esm --outfile=${OUTPUT_DIR}/player.js --sourcemap`,
  { stdio: 'pipe' }
);
console.log('Client bundle ready');

// Copy static assets
fs.copyFileSync('src/client/ui/styles.css', path.join(OUTPUT_DIR, 'styles.css'));

// Create player HTML (with bundled JS instead of TS)
const html = `<!DOCTYPE html>
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
    <canvas id="chart" width="600" height="200"></canvas>
  </div>
  <script type="module" src="player.js"></script>
</body>
</html>`;

fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), html);

// Step 3: Start HTTP server
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/bandwidth') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const report = JSON.parse(body);
        console.log(`  [bandwidth] client=${report.clientId} bw=${(report.measuredBandwidth / 1e6).toFixed(1)}Mbps quality=${report.currentQuality} buffer=${report.bufferLevel?.toFixed(1)}s`);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ack":true}');
    });
    return;
  }

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

  // Range request support
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
  console.log(`====================================`);
  console.log(`  Ray-HLS Demo Server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`====================================`);
  console.log('');
  console.log('Open the URL above in your browser.');
  console.log('Press Ctrl+C to stop.');
});
