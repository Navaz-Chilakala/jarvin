import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { BROWSER_EXTENSION_ID, type SharedBrowserPage } from '../shared/browser-share';

const ORIGIN = `chrome-extension://${BROWSER_EXTENSION_ID}`;
const MAX_BYTES = 100_000;
const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** A single-use, short-lived listener. It receives a page only after an explicit extension action. */
export class BrowserShare {
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private token = '';
  private generation = 0;
  constructor(private onPage: (page: SharedBrowserPage) => void) {}

  stop(): void {
    this.generation++;
    this.token = '';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); server.close(); }
  }

  async start(): Promise<{ code: string; expiresAt: number }> {
    this.stop();
    const generation = this.generation;
    const token = crypto.randomBytes(32).toString('hex');
    this.token = token;
    const server = http.createServer((req, res) => {
      const origin = req.headers.origin || '';
      const port = (server.address() as AddressInfo | null)?.port;
      const reply = (status: number, message: string) => { if (origin === ORIGIN) res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
      if (!port || req.headers.host !== `127.0.0.1:${port}` || origin !== ORIGIN || this.server !== server || this.generation !== generation) return reply(403, 'Not allowed.');
      if (req.method === 'OPTIONS' && req.url === '/share') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type, x-jarvin-token', 'Cache-Control': 'no-store' }); return res.end();
      }
      if (req.method !== 'POST' || req.url !== '/share' || !safeEqual(String(req.headers['x-jarvin-token'] || ''), this.token) || !this.token) return reply(403, 'Not allowed.');
      let bytes = 0; const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES) { reply(413, 'Page is too large.'); req.destroy(); } else chunks.push(chunk); });
      req.on('end', () => {
        if (bytes > MAX_BYTES || this.server !== server || !this.token) return;
        try {
          const page = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SharedBrowserPage;
          const url = new URL(page.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000 || typeof page.title !== 'string' || page.title.length > 500 || typeof page.text !== 'string' || page.text.length > 9000 || typeof page.truncated !== 'boolean') throw new Error('Invalid page.');
          this.token = ''; // Consume before notifying the renderer or accepting another request.
          res.once('finish', () => {
            if (this.server !== server) return;
            try { this.onPage({ url: url.href, title: page.title, text: page.text, truncated: page.truncated }); }
            finally { this.stop(); }
          });
          reply(200, 'Page sent to Jarvin for review.');
        } catch { reply(400, 'Invalid page.'); }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    if (this.server !== server || this.generation !== generation) { server.close(); throw new Error('Browser sharing was cancelled.'); }
    const expiresAt = Date.now() + 120_000;
    this.timer = setTimeout(() => { if (this.server === server) this.stop(); }, 120_000);
    return { code: `${(server.address() as AddressInfo).port}:${token}`, expiresAt };
  }
}
