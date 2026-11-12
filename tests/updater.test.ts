import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validUpdateUrl, updateText, type UpdateState } from '../src/shared/updatecfg';
import { createUpdater, type UpdaterLike } from '../src/main/updater';

test('update address: https only, plain http only for this PC', () => {
  assert.equal(validUpdateUrl('https://example.com/jarvin/').url, 'https://example.com/jarvin');
  assert.equal(validUpdateUrl('  https://example.com/a#x ').url, 'https://example.com/a');
  assert.equal(validUpdateUrl('http://127.0.0.1:8080/feed').ok, true);
  assert.equal(validUpdateUrl('http://localhost/feed').ok, true);
  for (const bad of ['http://example.com/x', 'ftp://example.com', 'file:///c:/x', 'javascript:alert(1)', 'https://u:p@example.com', 'example.com', '', '   ', null, 5]) assert.equal(validUpdateUrl(bad as any).ok, false, String(bad));
  assert.equal(validUpdateUrl('http://localhost.evil.com/x').ok, false);
});

class Fake implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  feed: any;
  handlers: Record<string, ((...a: any[]) => void)[]> = {};
  calls: string[] = [];
  checkImpl: () => Promise<unknown> = async () => { this.fire('update-not-available'); };
  setFeedURL(o: any) { this.feed = o; this.calls.push('feed'); }
  async checkForUpdates() { this.calls.push('check'); return this.checkImpl(); }
  async downloadUpdate() { this.calls.push('download'); this.fire('download-progress', { percent: 50 }); this.fire('update-downloaded', { version: '2.0.0' }); }
  quitAndInstall(s?: boolean, r?: boolean) { this.calls.push(`install:${s}:${r}`); }
  on(ev: string, cb: any) { (this.handlers[ev] ??= []).push(cb); return this; }
  fire(ev: string, ...a: any[]) { for (const h of this.handlers[ev] ?? []) h(...a); }
}

const make = (o: { packaged?: boolean; url?: string; fake?: Fake; load?: () => UpdaterLike } = {}) => {
  const fake = o.fake ?? new Fake();
  const seen: UpdateState[] = [];
  const u = createUpdater({ load: o.load ?? (() => fake), isPackaged: o.packaged ?? true, version: '1.0.0', getUrl: () => o.url, emit: (s) => seen.push(s) });
  return { u, fake, seen };
};

test('running from source never checks', async () => {
  const { u, fake } = make({ packaged: false, url: 'https://example.com/x' });
  const s = await u.check();
  assert.equal(s.phase, 'off');
  assert.equal(s.why, 'dev');
  assert.deepEqual(fake.calls, []);
  assert.match(updateText(s), /installed app/);
});

test('no address, or an unsafe one, never contacts anything', async () => {
  const a = make({ url: '' });
  assert.equal((await a.u.check()).phase, 'off');
  const b = make({ url: 'http://example.com/x' });
  const s = await b.u.check();
  assert.equal(s.phase, 'error');
  assert.match(s.error!, /https/);
  assert.deepEqual([...a.fake.calls, ...b.fake.calls], []);
});

test('a missing library is reported, not thrown', async () => {
  const { u } = make({ url: 'https://example.com/x', load: () => { throw new Error("Cannot find module 'electron-updater'"); } });
  const s = await u.check();
  assert.equal(s.phase, 'off');
  assert.equal(s.why, 'missing');
  assert.match(updateText(s), /npm install/);
});

test('check, download and install go one step at a time and never on their own', async () => {
  const { u, fake, seen } = make({ url: 'https://example.com/jarvin/' });
  fake.checkImpl = async () => { fake.fire('update-available', { version: '2.0.0' }); };
  let s = await u.check();
  assert.equal(s.phase, 'available');
  assert.equal(s.next, '2.0.0');
  assert.equal(fake.autoDownload, false);
  assert.equal(fake.autoInstallOnAppQuit, false);
  assert.deepEqual(fake.feed, { provider: 'generic', url: 'https://example.com/jarvin' });
  assert.equal(u.install(), false, 'cannot install before the download');
  assert.ok(!fake.calls.includes('download'));
  s = await u.download();
  assert.equal(s.phase, 'ready');
  assert.ok(seen.some((x) => x.phase === 'downloading' && x.pct === 50));
  assert.equal(u.install(), true);
  assert.equal(fake.calls.at(-1), 'install:false:true');
});

test('nothing newer, and errors from the server', async () => {
  const a = make({ url: 'https://example.com/x' });
  assert.equal((await a.u.check()).phase, 'current');
  const b = make({ url: 'https://example.com/x' });
  b.fake.checkImpl = async () => { throw new Error('404 Not Found\nat somewhere long'); };
  const s = await b.u.check();
  assert.equal(s.phase, 'error');
  assert.equal(s.error, '404 Not Found');
  const c = make({ url: 'https://example.com/x' });
  c.fake.checkImpl = async () => { c.fake.fire('error', new Error('signature mismatch')); };
  assert.match((await c.u.check()).error!, /signature/);
});

test('download is refused unless an update was found; the address change is picked up', async () => {
  let url = 'https://a.example.com/x';
  const fake = new Fake();
  const u = createUpdater({ load: () => fake, isPackaged: true, version: '1.0.0', getUrl: () => url, emit: () => {} });
  assert.equal((await u.download()).phase, 'idle');
  await u.check();
  url = 'https://b.example.com/y/';
  await u.check();
  assert.equal(fake.feed.url, 'https://b.example.com/y');
  assert.equal(fake.calls.filter((c) => c === 'feed').length, 2);
});
