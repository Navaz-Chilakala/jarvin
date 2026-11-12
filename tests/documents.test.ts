import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocument } from '../src/main/documents';

test('document worker is run in Node mode and returns extracted text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-doc-test-'));
  try {
    const worker = path.join(dir, 'worker.cjs');
    fs.writeFileSync(worker, 'process.stdout.write(JSON.stringify({ok:true,text:process.env.ELECTRON_RUN_AS_NODE, pages:2}))');
    assert.equal(await readDocument('pdf', 'unused', new AbortController().signal, { worker }), '1\n\n[2 pages]');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('document reading can be cancelled without waiting for its timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-doc-test-'));
  try {
    const worker = path.join(dir, 'worker.cjs');
    fs.writeFileSync(worker, 'setTimeout(() => {}, 30000)');
    const controller = new AbortController();
    const reading = readDocument('docx', 'unused', controller.signal, { worker });
    controller.abort();
    await assert.rejects(reading, /cancelled/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
