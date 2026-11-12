/** Optional Qwen routine check; all writes are restricted to a temporary workspace. */
import { runAgent } from '../src/main/agent';
import { builtinTools } from '../src/main/tools';
import { routineRequest } from '../src/shared/routines';
import type { Settings } from '../src/shared/types';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-routine-live-'));
const history: any[] = [{ role: 'user', content: routineRequest({ id: 'test', revision: 'test', name: 'Verify a note', steps: ['Use write_file to create the file routine-note.txt containing exactly the text blue lantern.', 'Use read_file to read routine-note.txt and report its content.'], createdAt: 0, updatedAt: 0 }) }];
const settings = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 16384, temperature: 0.2, maxSteps: 6 } as Settings;
const starts: string[] = [];
const success: string[] = [];
const ids = new Map<string, string>();
runAgent({
  settings, history, tools: builtinTools,
  system: `You are Jarvin. Work in the user's workspace ${root}. Follow the user's instructions and use the available tools.`,
  ctx: { root, signal: AbortSignal.timeout(180_000) },
  approve: async (tool, args) => ['write_file', 'read_file'].includes(tool.name) && args?.path === 'routine-note.txt',
  emit: (e) => {
    if (e.type === 'tool_start') { ids.set(e.id, e.name); starts.push(e.name); console.log(`Tool: ${e.name}`); }
    if (e.type === 'tool_result') { if (e.ok) success.push(ids.get(e.id) || ''); console.log(`Result: ${e.ok ? 'ok' : 'failed'} ${e.output.slice(0, 300)}`); }
  },
}).then((outcome) => {
  const note = fs.readFileSync(path.join(root, 'routine-note.txt'), 'utf8').trim();
  if (outcome !== 'finished' || note !== 'blue lantern' || !success.includes('write_file') || !success.includes('read_file') || starts.indexOf('write_file') > starts.indexOf('read_file')) throw new Error('Qwen did not execute the two routine steps successfully in order.');
  console.log('Real Qwen routine check passed using temporary data.');
}).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
