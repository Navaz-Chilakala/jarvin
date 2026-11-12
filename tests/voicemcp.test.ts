import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, clampListen, newToken, tokenEqual, clientConfig, VOICE_TOOLS } from '../src/shared/voicemcp';

const P = 39517;
const T = 'secret-token';
const good = { method: 'POST', url: '/mcp', host: `127.0.0.1:${P}`, auth: `Bearer ${T}` };

test('a correct request passes', () => {
  assert.deepEqual(checkRequest(good, P, T), { ok: true });
  assert.deepEqual(checkRequest({ ...good, host: `localhost:${P}`, url: '/mcp?x=1' }, P, T), { ok: true });
  assert.deepEqual(checkRequest({ ...good, auth: `bearer ${T}` }, P, T), { ok: true });
});

test('wrong host, any origin, wrong path or method, bad token are all refused', () => {
  const st = (o: object) => { const r = checkRequest({ ...good, ...o }, P, T); return r.ok === true ? 200 : (r as { status: number }).status; };
  assert.equal(st({ host: 'evil.com' }), 403);
  assert.equal(st({ host: `127.0.0.1:${P + 1}` }), 403, 'DNS-rebinding style host');
  assert.equal(st({ host: undefined }), 403);
  assert.equal(st({ origin: 'http://evil.com' }), 403);
  assert.equal(st({ origin: 'null' }), 403);
  assert.equal(st({ url: '/other' }), 404);
  assert.equal(st({ method: 'GET' }), 405);
  assert.equal(st({ auth: undefined }), 401);
  assert.equal(st({ auth: 'Bearer wrong' }), 401);
  assert.equal(st({ auth: `Basic ${T}` }), 401);
  assert.equal(checkRequest(good, P, '').ok, false, 'empty server token never matches');
});

test('tokens are random, long and compared safely', () => {
  const a = newToken();
  assert.ok(a.length >= 30);
  assert.notEqual(a, newToken());
  assert.equal(tokenEqual(a, a), true);
  assert.equal(tokenEqual(a, a + 'x'), false);
  assert.equal(tokenEqual('', ''), true);
});

test('listen seconds are clamped; tool list and config are well formed', () => {
  assert.equal(clampListen(undefined), 15);
  assert.equal(clampListen('abc'), 15);
  assert.equal(clampListen(0), 2);
  assert.equal(clampListen(9999), 60);
  assert.equal(clampListen(7.6), 8);
  assert.deepEqual(VOICE_TOOLS.map((t) => t.name), ['listen', 'speak', 'transcribe_file']);
  for (const t of VOICE_TOOLS) assert.equal((t.inputSchema as any).type, 'object');
  const cfg = JSON.parse(clientConfig(1234, 'tok'));
  assert.equal(cfg.mcpServers['jarvin-voice'].url, 'http://127.0.0.1:1234/mcp');
  assert.equal(cfg.mcpServers['jarvin-voice'].headers.Authorization, 'Bearer tok');
});
