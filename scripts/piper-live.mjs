import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['.test-out/piper-live.cjs'], { cwd: process.cwd(), windowsHide: true, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
if (result.code !== 0) throw new Error(`Natural voice test failed: ${JSON.stringify(result)}`);
