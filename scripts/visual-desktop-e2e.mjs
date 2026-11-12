import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-visual-desktop-'));
try {
  const child = spawn(electron, ['.test-out/visual-desktop-fixture.cjs', `--user-data-dir=${path.join(root, 'runner-profile')}`], { cwd: process.cwd(), windowsHide: true, stdio: 'inherit', env: { ...process.env, JARVIN_VISUAL_TEST_ROOT: root } });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (result.code !== 0) throw new Error(`Real visual desktop test failed: ${JSON.stringify(result)}`);
} finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
