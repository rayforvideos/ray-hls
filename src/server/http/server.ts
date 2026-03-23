import http from 'http';
import { EventEmitter } from 'events';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export class HLSServer extends EventEmitter {
  private port: number;
  private server: http.Server;
  private masterPlaylist: string | null = null;
  private mediaPlaylists: Map<string, string> = new Map();
  private segments: Map<string, Buffer> = new Map();

  constructor(port: number) {
    super();
    this.port = port;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  setMasterPlaylist(content: string): void {
    this.masterPlaylist = content;
  }

  setMediaPlaylist(quality: string, content: string): void {
    this.mediaPlaylists.set(quality, content);
  }

  addSegment(quality: string, filename: string, data: Buffer): void {
    this.segments.set(`${quality}/${filename}`, data);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // OPTIONS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // POST /api/bandwidth
    if (method === 'POST' && url === '/api/bandwidth') {
      this.handleBandwidthReport(req, res);
      return;
    }

    // GET routes
    if (method === 'GET') {
      // GET /master.m3u8
      if (url === '/master.m3u8') {
        if (this.masterPlaylist === null) {
          this.send404(res);
          return;
        }
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(this.masterPlaylist);
        return;
      }

      // GET /{quality}/playlist.m3u8
      const playlistMatch = url.match(/^\/([^/]+)\/playlist\.m3u8$/);
      if (playlistMatch) {
        const quality = playlistMatch[1];
        const content = this.mediaPlaylists.get(quality);
        if (content === undefined) {
          this.send404(res);
          return;
        }
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(content);
        return;
      }

      // GET /{quality}/{filename}.ts
      const segmentMatch = url.match(/^\/([^/]+)\/([^/]+\.ts)$/);
      if (segmentMatch) {
        const quality = segmentMatch[1];
        const filename = segmentMatch[2];
        const key = `${quality}/${filename}`;
        const data = this.segments.get(key);
        if (data === undefined) {
          this.send404(res);
          return;
        }
        this.serveSegment(req, res, data);
        return;
      }
    }

    this.send404(res);
  }

  private serveSegment(req: http.IncomingMessage, res: http.ServerResponse, data: Buffer): void {
    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] !== '' ? parseInt(match[2], 10) : data.length - 1;

        if (start > end || start >= data.length) {
          res.writeHead(416, { ...CORS_HEADERS, 'Content-Range': `bytes */${data.length}` });
          res.end();
          return;
        }

        const chunk = data.subarray(start, end + 1);
        res.writeHead(206, {
          ...CORS_HEADERS,
          'Content-Type': 'video/mp2t',
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': chunk.length,
        });
        res.end(chunk);
        return;
      }
    }

    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'video/mp2t',
      'Content-Length': data.length,
    });
    res.end(data);
  }

  private handleBandwidthReport(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: object = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        // ignore parse errors, emit empty object
      }
      this.emit('bandwidthReport', body);
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ack: true }));
    });
  }

  private send404(res: http.ServerResponse): void {
    res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}
