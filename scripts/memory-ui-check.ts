import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

test('memory dashboard loads, saves and deletes through its UI', { timeout: 30_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-memory-ui-'));
  try {
    const bundle = path.join(root, 'memoryui.js');
    buildSync({ entryPoints: [path.join(process.cwd(), 'src/renderer/memoryui.ts')], outfile: bundle, bundle: true, platform: 'browser', format: 'iife', globalName: 'MemoryUiBundle', logLevel: 'silent' });
    const electron = require('electron') as string;
    const env = { ...process.env, JARVIN_TEST_DATA: root, JARVIN_UI_BUNDLE: bundle };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = execFileSync(electron, [path.join(process.cwd(), 'scripts/memory-ui-test.cjs')], { env, encoding: 'utf8', timeout: 25_000, windowsHide: true });
    assert.match(result, /opened, loaded, saved and deleted/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
