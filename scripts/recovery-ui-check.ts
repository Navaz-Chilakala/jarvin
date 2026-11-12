import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

test('recovery UI reviews a task without running it', { timeout: 30_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-recovery-ui-'));
  try {
    const bundle = path.join(root, 'tasksui.js');
    buildSync({ entryPoints: [path.join(process.cwd(), 'src/renderer/tasksui.ts')], outfile: bundle, bundle: true, platform: 'browser', format: 'iife', globalName: 'TasksUiBundle', logLevel: 'silent' });
    const electron = require('electron') as string;
    const env = { ...process.env, JARVIN_TEST_DATA: root, JARVIN_UI_BUNDLE: bundle };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = execFileSync(electron, [path.join(process.cwd(), 'scripts/recovery-ui-test.cjs')], { env, encoding: 'utf8', timeout: 25_000, windowsHide: true });
    assert.match(result, /reviewed and dismissed a test record without running it/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
