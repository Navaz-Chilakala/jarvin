import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-chrome-visual-'));
try {
  const child = spawn(electron, ['.test-out/chrome-visual-fixture.cjs', `--user-data-dir=${path.join(root, 'runner-profile')}`, ...process.argv.slice(2)], { cwd: process.cwd(), windowsHide: true, stdio: 'inherit', env: { ...process.env, JARVIN_CHROME_VISUAL_ROOT: root } });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (result.code !== 0) throw new Error(`Chrome visual task failed: ${JSON.stringify(result)}`);
} finally {
  const expected = path.resolve(os.tmpdir()) + path.sep;
  if (path.resolve(root).startsWith(expected) && path.basename(root).startsWith('jarvin-chrome-visual-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
