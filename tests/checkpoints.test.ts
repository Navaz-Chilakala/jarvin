import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointStore } from '../src/main/checkpoints';

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-cp-'));
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A0');
  fs.writeFileSync(path.join(ws, 'src', 'b.txt'), 'B0');
  const store = new CheckpointStore(path.join(base, 'cp'));
  const rd = (p: string) => fs.readFileSync(path.join(ws, p), 'utf8');
  const turn = (label: string, edit: (w: (p: string, c: string) => void) => void) => {
    const rec = store.begin(ws, label);
    edit((p, c) => {
      const abs = path.join(ws, p);
      rec.beforeWrite(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, c);
    });
    return rec.finish();
  };
  return { ws, store, rd, turn, base };
}

test('records modified and created files, rewind restores and deletes', () => {
  const { ws, store, rd, turn } = setup();
  const s = turn('t1', (w) => {
    w('a.txt', 'A1');
    w('new/deep/c.txt', 'C1');
  })!;
  assert.deepEqual(s.files.map((f) => `${f.status}:${f.path}`).sort(), ['created:new/deep/c.txt', 'modified:a.txt']);
  const r = store.rewind(ws, s.id);
  assert.deepEqual([r.ok, r.restored, r.deleted], [true, 1, 1]);
  assert.equal(rd('a.txt'), 'A0');
  assert.equal(fs.existsSync(path.join(ws, 'new')), false, 'empty folders created by the agent are removed');
  assert.equal(store.preview(ws, s.id).files.length, 0, 'checkpoint is gone after rewind');
});

test('only the first write per file is recorded within a turn', () => {
  const { ws, store, rd, turn } = setup();
  const s = turn('t', (w) => {
    w('a.txt', 'A1');
    w('a.txt', 'A2');
    w('a.txt', 'A3');
  })!;
  assert.equal(s.files.length, 1);
  store.rewind(ws, s.id);
  assert.equal(rd('a.txt'), 'A0');
});

test('turns that change nothing leave no checkpoint', () => {
  const { turn } = setup();
  assert.equal(turn('same bytes', (w) => w('a.txt', 'A0')), null);
  assert.equal(turn('no writes', () => {}), null);
  assert.equal(turn('create then delete', (w) => w('tmp.txt', 'x') ) !== null, true, 'created file still exists');
});

test('rewinding an older turn also undoes newer turns', () => {
  const { ws, store, rd, turn } = setup();
  const t1 = turn('t1', (w) => w('a.txt', 'A1'))!;
  const t2 = turn('t2', (w) => {
    w('a.txt', 'A2');
    w('src/b.txt', 'B2');
  })!;
  const t3 = turn('t3', (w) => w('later.txt', 'L3'))!;
  const pv = store.preview(ws, t1.id);
  assert.equal(pv.laterTurns, 2);
  assert.ok(pv.files.some((f) => f.path === 'later.txt' && f.action === 'delete'));
  const r = store.rewind(ws, t1.id);
  assert.ok(r.ok);
  assert.equal(rd('a.txt'), 'A0');
  assert.equal(rd('src/b.txt'), 'B0');
  assert.equal(fs.existsSync(path.join(ws, 'later.txt')), false);
  assert.equal(store.preview(ws, t2.id).files.length, 0);
  assert.equal(store.preview(ws, t3.id).files.length, 0);
});

test('rewinding only the newest turn keeps older changes', () => {
  const { ws, store, rd, turn } = setup();
  turn('t1', (w) => w('a.txt', 'A1'));
  const t2 = turn('t2', (w) => w('a.txt', 'A2'))!;
  assert.ok(store.rewind(ws, t2.id).ok);
  assert.equal(rd('a.txt'), 'A1');
});

test('a file created in one turn and edited in the next is removed when rewinding the first', () => {
  const { ws, store, turn } = setup();
  const t1 = turn('t1', (w) => w('n.txt', 'N1'))!;
  turn('t2', (w) => w('n.txt', 'N2'));
  const r = store.rewind(ws, t1.id);
  assert.deepEqual([r.ok, r.restored, r.deleted], [true, 0, 1]);
  assert.equal(fs.existsSync(path.join(ws, 'n.txt')), false);
});

test('files edited by hand after the turn are reported, and kept unless forced', () => {
  const { ws, store, rd, turn } = setup();
  const s = turn('t', (w) => w('a.txt', 'A1'))!;
  fs.writeFileSync(path.join(ws, 'a.txt'), 'my own edit');
  assert.equal(store.preview(ws, s.id).files[0].conflict, true);
  const r = store.rewind(ws, s.id);
  assert.deepEqual([r.ok, r.conflicts], [false, ['a.txt']]);
  assert.equal(rd('a.txt'), 'my own edit');
  assert.ok(store.rewind(ws, s.id, true).ok);
  assert.equal(rd('a.txt'), 'A0');
});

test('deleted-by-hand files are restored without complaint when unchanged expectations hold', () => {
  const { ws, store, rd, turn } = setup();
  const s = turn('t', (w) => w('a.txt', 'A1'))!;
  fs.rmSync(path.join(ws, 'a.txt'));
  assert.equal(store.preview(ws, s.id).files[0].conflict, true);
  assert.ok(store.rewind(ws, s.id, true).ok);
  assert.equal(rd('a.txt'), 'A0');
});

test('binary files round-trip', () => {
  const { ws, store, turn } = setup();
  const bin = Buffer.from([0, 255, 1, 254, 2, 0, 0, 10, 13]);
  fs.writeFileSync(path.join(ws, 'x.bin'), bin);
  const s = turn('t', (w) => w('x.bin', 'text now'))!;
  store.rewind(ws, s.id);
  assert.ok(fs.readFileSync(path.join(ws, 'x.bin')).equals(bin));
});

test('persists across store instances and keeps only the newest 50', () => {
  const { ws, store, base, turn } = setup();
  const first = turn('first', (w) => w('a.txt', 'v0'))!;
  for (let i = 1; i <= 52; i++) turn(`t${i}`, (w) => w('a.txt', `v${i}`));
  const again = new CheckpointStore(path.join(base, 'cp'));
  assert.equal(again.preview(ws, first.id).files.length, 0, 'oldest were pruned');
  assert.equal(fs.existsSync(store.blobDir(ws, first.id)), false, 'and their blobs removed');
});

test('a tampered index cannot make rewind write outside the workspace', () => {
  const { ws, store, base, turn } = setup();
  const s = turn('t', (w) => w('a.txt', 'A1'))!;
  const idx = path.join(base, 'cp', fs.readdirSync(path.join(base, 'cp'))[0], 'index.json');
  const list = JSON.parse(fs.readFileSync(idx, 'utf8'));
  list[0].files[0].path = '../escaped.txt';
  fs.writeFileSync(idx, JSON.stringify(list));
  assert.throws(() => store.rewind(ws, s.id, true), /outside the workspace/);
  assert.equal(fs.existsSync(path.join(base, 'escaped.txt')), false);
});

test('files over 20 MB are refused before any change', () => {
  const { ws, store } = setup();
  fs.writeFileSync(path.join(ws, 'big.bin'), Buffer.alloc(21 * 1024 * 1024));
  const rec = store.begin(ws, 't');
  assert.throws(() => rec.beforeWrite(path.join(ws, 'big.bin')), /20 MB/);
});

test('sweep removes orphaned blobs from interrupted turns', () => {
  const { ws, store, turn } = setup();
  const rec = store.begin(ws, 'crash');
  rec.beforeWrite(path.join(ws, 'a.txt')); // never finished
  const ok = turn('fine', (w) => w('a.txt', 'A1'))!;
  store.sweep(ws);
  assert.equal(fs.existsSync(store.blobDir(ws, rec.id)), false);
  assert.equal(fs.existsSync(store.blobDir(ws, ok.id)), true);
});

test('terminal command changes (create, modify, delete) are recorded and undone', async () => {
  const { ws, store, rd } = setup();
  fs.writeFileSync(path.join(ws, 'gone.txt'), 'G0');
  fs.mkdirSync(path.join(ws, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'i.js'), 'dep');
  const rec = store.begin(ws, 'cmd');
  const end = await rec.trackCommand();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A-CHANGED-LONGER');
  fs.writeFileSync(path.join(ws, 'made.txt'), 'M');
  fs.rmSync(path.join(ws, 'gone.txt'));
  fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'i.js'), 'changed dep');
  assert.equal(await end(), 3);
  const s = rec.finish()!;
  assert.deepEqual(s.files.map((f) => `${f.status}:${f.path}`).sort(), ['created:made.txt', 'deleted:gone.txt', 'modified:a.txt']);
  const r = store.rewind(ws, s.id);
  assert.equal(r.ok, true);
  assert.equal(rd('a.txt'), 'A0');
  assert.equal(rd('gone.txt'), 'G0');
  assert.equal(fs.existsSync(path.join(ws, 'made.txt')), false);
  assert.equal(rd('src/b.txt'), 'B0');
});

test('a file edited by a tool and then a command keeps its original baseline; unchanged runs record nothing', async () => {
  const { ws, store, rd } = setup();
  const rec = store.begin(ws, 'mix');
  rec.beforeWrite(path.join(ws, 'a.txt'));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A1');
  const end = await rec.trackCommand();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'A2');
  await end();
  const s = rec.finish()!;
  assert.equal(s.files.length, 1);
  store.rewind(ws, s.id);
  assert.equal(rd('a.txt'), 'A0');
  const rec2 = store.begin(ws, 'noop');
  const end2 = await rec2.trackCommand();
  assert.equal(await end2(), 0);
  assert.equal(rec2.finish(), null);
});
