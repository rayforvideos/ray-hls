import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

page.on('console', msg => console.log(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => console.log(`[PAGE ERROR] ${err.message}`));

await page.goto('http://localhost:8080');
await page.waitForTimeout(2000);
await page.click('video', { force: true });
console.log('--- Clicked play ---');

for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => {
    const v = document.querySelector('video');
    const vb = v.webkitSourceBuffered || null;
    // Check each SourceBuffer in MediaSource
    let videoBuffEnd = 0, audioBuffEnd = 0;
    try {
      const ms = v.srcObject || null;
    } catch {}
    return {
      time: v.currentTime.toFixed(2),
      duration: v.duration.toFixed(2),
      paused: v.paused,
      ended: v.ended,
      readyState: v.readyState,
      buffered: v.buffered.length > 0
        ? Array.from({length: v.buffered.length}, (_, i) =>
            v.buffered.start(i).toFixed(2) + '-' + v.buffered.end(i).toFixed(2)).join(', ')
        : 'none',
    };
  });
  console.log(`t=${state.time}/${state.duration} | buf=[${state.buffered}] | paused=${state.paused} ended=${state.ended} rs=${state.readyState}`);
  if (state.ended) {
    console.log('--- Video ended normally! ---');
    break;
  }
}

await page.screenshot({ path: 'demo-output/screenshot.png' });
console.log('Screenshot saved');
await page.waitForTimeout(2000);
await browser.close();
