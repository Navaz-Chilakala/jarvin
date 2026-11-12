import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-vision-window-'));
try {
  const child = spawn(electron, ['.test-out/vision-window-fixture.cjs', `--user-data-dir=${path.join(root, 'runner-profile')}`], { cwd: process.cwd(), windowsHide: true, stdio: 'inherit', env: { ...process.env, JARVIN_VISION_FIXTURE_ROOT: root } });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (result.code !== 0) throw new Error(`Vision fixture failed: ${JSON.stringify(result)}`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
