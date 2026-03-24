import { HLSPlayer } from './player/hls-player.js';
import { DebugPanel } from './ui/debug-panel.js';

const video = document.getElementById('video') as HTMLVideoElement;
const strategySelect = document.getElementById('abr-strategy') as HTMLSelectElement;

const player = new HLSPlayer(video);
const debug = new DebugPanel('chart');

// Strategy switching (delay until ABR is initialized)
strategySelect.addEventListener('change', () => {
  try {
    player.abr.setStrategy(strategySelect.value);
  } catch { /* ABR not ready yet */ }
});

// Update debug panel every second
setInterval(() => {
  try {
    debug.update({
      state: player.state,
      quality: player.lastQuality,
      bandwidth: player.lastBandwidth,
      bufferLevel: player.lastBufferLevel,
      strategy: player.abr.currentStrategyName,
    });
  } catch {
    debug.update({
      state: player.state,
      quality: '-',
      bandwidth: 0,
      bufferLevel: 0,
      strategy: '-',
    });
  }
}, 1000);

// Auto-load
const params = new URLSearchParams(window.location.search);
const src = params.get('src') ?? '/master.m3u8';
player.load(src);
