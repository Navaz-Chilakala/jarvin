import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserShare } from '../src/main/browser-share';
import { BROWSER_EXTENSION_ID } from '../src/shared/browser-share';

test('extension identity matches the packaged manifest key', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'browser-extension', 'manifest.json'), 'utf8'));
  const hash = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  assert.equal(Array.from(hash, (b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join(''), BROWSER_EXTENSION_ID);
});

test('browser sharing requires the extension origin and one-time code and never accepts unsafe URLs', async () => {
  const received: unknown[] = [];
  const share = new BrowserShare((page) => received.push(page));
  try {
    const { code } = await share.start();
    const [port, token] = code.split(':');
    const url = `http://127.0.0.1:${port}/share`;
    const origin = `chrome-extension://${BROWSER_EXTENSION_ID}`;
    const page = { url: 'https://example.com/article', title: 'Example', text: 'Hello', truncated: false };
    const post = (body: unknown, o = origin, t = token) => fetch(url, { method: 'POST', headers: { Origin: o, 'Content-Type': 'application/json', 'X-Jarvin-Token': t }, body: JSON.stringify(body) });
    assert.equal((await post(page, 'https://example.com')).status, 403);
    assert.equal((await post(page, origin, 'wrong')).status, 403);
    assert.equal((await post({ ...page, url: 'file:///secret' })).status, 400);
    assert.deepEqual(received, []);
    assert.equal((await post(page)).status, 200);
    assert.deepEqual(received, [page]);
    const second = await post(page).then((r) => r.status, () => 0);
    assert.notEqual(second, 200);
    assert.equal(received.length, 1);
  } finally { share.stop(); }
});
