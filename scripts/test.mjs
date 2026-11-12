// Compiles every tests/*.test.ts and runs them with node:test. Add a test file and it is picked up automatically.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const tests = readdirSync('tests').filter((f) => f.endsWith('.test.ts'));
const run = (cmd, args, shell = process.platform === 'win32') =>
  spawnSync(cmd, args, { stdio: 'inherit', shell });

const tsc = run('npx', ['tsc', ...tests.map((f) => `tests/${f}`), '--outDir', '.test-out', '--module', 'commonjs', '--target', 'es2022', '--esModuleInterop', '--skipLibCheck', '--types', 'node']);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
// node lives under "C:\Program Files\...", so run it without a shell to keep the space in the path intact.
const node = run(process.execPath, ['--test', ...tests.map((f) => `.test-out/tests/${f.replace(/\.ts$/, '.js')}`)], false);
process.exit(node.status ?? 1);
