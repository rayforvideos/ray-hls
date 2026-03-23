import http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HLSServer } from '../../../src/server/http/server.js';

const PORT = 9876;

function request(options: http.RequestOptions, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string | Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function get(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return request({ hostname: 'localhost', port: PORT, path, method: 'GET' }) as Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
}

function options(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return request({ hostname: 'localhost', port: PORT, path, method: 'OPTIONS' }) as Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
}

function post(path: string, jsonBody: object): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const body = JSON.stringify(jsonBody);
  return request(
    { hostname: 'localhost', port: PORT, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    body
  ) as Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
}

function getWithRange(path: string, range: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return request(
    { hostname: 'localhost', port: PORT, path, method: 'GET', headers: { Range: range } }
  ) as Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
}

let server: HLSServer;

beforeAll(async () => {
  server = new HLSServer(PORT);
  server.setMasterPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n');
  server.setMediaPlaylist('720p', '#EXTM3U\n#EXT-X-TARGETDURATION:4\n');
  server.addSegment('720p', 'seg0.ts', Buffer.from('fake-ts-data-720p-seg0'));
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe('HLSServer', () => {
  describe('GET /master.m3u8', () => {
    it('serves master playlist with correct content type', async () => {
      const res = await get('/master.m3u8');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
      expect(res.body.toString()).toBe('#EXTM3U\n#EXT-X-VERSION:3\n');
    });
  });

  describe('GET /{quality}/playlist.m3u8', () => {
    it('serves media playlist', async () => {
      const res = await get('/720p/playlist.m3u8');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
      expect(res.body.toString()).toBe('#EXTM3U\n#EXT-X-TARGETDURATION:4\n');
    });

    it('returns 404 for unknown quality', async () => {
      const res = await get('/1080p/playlist.m3u8');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /{quality}/{filename}.ts', () => {
    it('serves TS segments with correct content type', async () => {
      const res = await get('/720p/seg0.ts');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('video/mp2t');
      expect(res.body.toString()).toBe('fake-ts-data-720p-seg0');
    });

    it('returns 404 for unknown segment', async () => {
      const res = await get('/720p/seg99.ts');
      expect(res.status).toBe(404);
    });
  });

  describe('CORS headers', () => {
    it('includes CORS headers on GET responses', async () => {
      const res = await get('/master.m3u8');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
      expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
    });

    it('includes CORS headers on 404 responses', async () => {
      const res = await get('/nonexistent');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('OPTIONS preflight', () => {
    it('responds 204 with CORS headers', async () => {
      const res = await options('/master.m3u8');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
      expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
    });
  });

  describe('POST /api/bandwidth', () => {
    it('accepts bandwidth reports and responds with {"ack":true}', async () => {
      const res = await post('/api/bandwidth', { bitrate: 2500000, quality: '720p' });
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body.toString());
      expect(json).toEqual({ ack: true });
    });

    it('emits bandwidthReport event with parsed body', async () => {
      const received: object[] = [];
      server.on('bandwidthReport', (data) => received.push(data));
      await post('/api/bandwidth', { bitrate: 1000000 });
      expect(received.length).toBe(1);
      expect((received[0] as { bitrate: number }).bitrate).toBe(1000000);
    });
  });

  describe('Range requests on .ts segments', () => {
    it('returns 206 with correct Content-Range for a bounded range', async () => {
      const data = Buffer.from('fake-ts-data-720p-seg0');
      const res = await getWithRange('/720p/seg0.ts', 'bytes=0-3');
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-3/${data.length}`);
      expect(res.body.toString()).toBe('fake');
    });

    it('returns 206 with correct Content-Range for an open-ended range', async () => {
      const data = Buffer.from('fake-ts-data-720p-seg0');
      const res = await getWithRange('/720p/seg0.ts', `bytes=4-`);
      expect(res.status).toBe(206);
      const end = data.length - 1;
      expect(res.headers['content-range']).toBe(`bytes 4-${end}/${data.length}`);
      expect(res.body.toString()).toBe('-ts-data-720p-seg0');
    });

    it('returns 200 with full content when no Range header', async () => {
      const res = await get('/720p/seg0.ts');
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe('fake-ts-data-720p-seg0');
    });
  });

  describe('404 for unknown paths', () => {
    it('returns 404 for completely unknown path', async () => {
      const res = await get('/unknown/path/here');
      expect(res.status).toBe(404);
    });
  });
});
