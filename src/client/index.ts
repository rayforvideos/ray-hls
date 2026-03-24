import { HLSPlayer } from './player/hls-player.js';
import { DebugPanel } from './ui/debug-panel.js';

const video = document.getElementById('video') as HTMLVideoElement;
const strategySelect = document.getElementById('abr-strategy') as HTMLSelectElement;
const qualitySelect = document.getElementById('quality-select') as HTMLSelectElement;

const player = new HLSPlayer(video);
const debug = new DebugPanel('chart');

// Strategy switching
strategySelect.addEventListener('change', () => {
  try {
    player.abr.setStrategy(strategySelect.value);
  } catch { /* ABR not ready yet */ }
});

// Quality switching
qualitySelect.addEventListener('change', () => {
  try {
    const value = qualitySelect.value;
    player.abr.lockQuality(value === 'auto' ? null : value);
  } catch { /* ABR not ready yet */ }
});

// Populate quality options once player is loaded
const populateQualities = setInterval(() => {
  try {
    const levels = player.abr.getQualityLevels();
    if (levels.length > 0 && qualitySelect.options.length <= 1) {
      for (const level of levels) {
        const opt = document.createElement('option');
        opt.value = level.name;
        opt.textContent = `${level.name} (${level.width}x${level.height})`;
        qualitySelect.appendChild(opt);
      }
      clearInterval(populateQualities);
    }
  } catch { /* not ready */ }
}, 500);

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
