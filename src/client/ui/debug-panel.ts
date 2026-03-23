interface Stats {
  state: string;
  quality: string;
  bandwidth: number;
  bufferLevel: number;
  strategy: string;
}

interface DataPoint {
  bandwidth: number;
  bufferLevel: number;
}

const MAX_POINTS = 100;

export class DebugPanel {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private data: DataPoint[] = [];

  constructor(canvasId: string) {
    const el = document.getElementById(canvasId);
    if (!(el instanceof HTMLCanvasElement)) {
      throw new Error(`Element #${canvasId} is not a canvas`);
    }
    this.canvas = el;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2d context from canvas');
    }
    this.ctx = ctx;
  }

  update(stats: Stats): void {
    // Update DOM stats
    this.setText('stat-state', stats.state);
    this.setText('stat-quality', stats.quality);
    this.setText('stat-bandwidth', stats.bandwidth > 0 ? `${(stats.bandwidth / 1000).toFixed(1)} kbps` : '-');
    this.setText('stat-buffer', stats.bufferLevel > 0 ? `${stats.bufferLevel.toFixed(1)} s` : '-');
    this.setText('stat-strategy', stats.strategy);

    // Record data point (rolling window of 100)
    this.data.push({ bandwidth: stats.bandwidth, bufferLevel: stats.bufferLevel });
    if (this.data.length > MAX_POINTS) {
      this.data.shift();
    }

    this.draw();
  }

  private setText(id: string, value: string): void {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = value;
    }
  }

  private draw(): void {
    const { width, height } = this.canvas;
    const ctx = this.ctx;

    // Clear
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);

    if (this.data.length < 2) return;

    // Compute max values for normalization
    const maxBandwidth = Math.max(...this.data.map((d) => d.bandwidth), 1);
    const maxBuffer = Math.max(...this.data.map((d) => d.bufferLevel), 1);

    const paddingTop = 30;
    const paddingBottom = 10;
    const paddingLeft = 10;
    const paddingRight = 10;
    const chartWidth = width - paddingLeft - paddingRight;
    const chartHeight = height - paddingTop - paddingBottom;

    const xStep = chartWidth / (this.data.length - 1);

    // Draw bandwidth line (cyan #53d8fb)
    ctx.beginPath();
    ctx.strokeStyle = '#53d8fb';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < this.data.length; i++) {
      const x = paddingLeft + i * xStep;
      const normalised = this.data[i].bandwidth / maxBandwidth;
      const y = paddingTop + chartHeight * (1 - normalised);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw buffer level line (green #00ff88)
    ctx.beginPath();
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < this.data.length; i++) {
      const x = paddingLeft + i * xStep;
      const normalised = this.data[i].bufferLevel / maxBuffer;
      const y = paddingTop + chartHeight * (1 - normalised);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Legend
    ctx.font = '11px Courier New, monospace';

    ctx.fillStyle = '#53d8fb';
    ctx.fillRect(paddingLeft, 6, 12, 2);
    ctx.fillText('Bandwidth', paddingLeft + 16, 12);

    ctx.fillStyle = '#00ff88';
    ctx.fillRect(paddingLeft + 90, 6, 12, 2);
    ctx.fillText('Buffer', paddingLeft + 106, 12);
  }
}
