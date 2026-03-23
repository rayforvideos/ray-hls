import { HLSPlayer } from './player/hls-player.js';
import { DebugPanel } from './ui/debug-panel.js';

const video = document.getElementById('video') as HTMLVideoElement;
const strategySelect = document.getElementById('abr-strategy') as HTMLSelectElement;

const player = new HLSPlayer(video);
const debug = new DebugPanel('chart');

strategySelect.addEventListener('change', () => {
  player.abr.setStrategy(strategySelect.value);
});

// Update debug panel every second
setInterval(() => {
  debug.update({
    state: player.state,
    quality: '-', // will be updated when playing
    bandwidth: 0,
    bufferLevel: 0,
    strategy: player.abr.currentStrategyName,
  });
}, 1000);

// Auto-load
const params = new URLSearchParams(window.location.search);
const src = params.get('src') ?? '/master.m3u8';
player.load(src);
