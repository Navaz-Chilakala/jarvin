/** Real local model, simulated browser and observation: verifies routing, not Chrome itself. */
import { runAgent } from '../src/main/agent';
import { builtinTools } from '../src/main/tools';
import { VISIBLE_CHROME_PROMPT } from '../src/main/browser-policy';
import type { Settings } from '../src/shared/types';

const names = ['chrome_search', 'desktop_list_windows', 'focus_window', 'desktop_inspect_window', 'see_window', 'inspect_screen', 'web_search', 'web_fetch', 'research_web'];
const seen: string[] = [];
const tools = builtinTools.filter((tool) => names.includes(tool.name)).map((tool) => ({
  ...tool,
  run: async () => {
    seen.push(tool.name);
    if (tool.name === 'chrome_search') return 'Chrome opened a simulated search page. Inspect it to read results.';
    if (tool.name === 'desktop_list_windows') return JSON.stringify({ windows: [{ window_id: 'w1', app: 'chrome', title: 'Jarvin fixture result - Google Search' }] });
    if (tool.name === 'focus_window') return 'Chrome is in the foreground.';
    if (tool.name === 'see_window') return 'The visible test page says: The fixture result is blue.';
    throw new Error('Background fetching is not permitted in this test.');
  },
}));
const history: any[] = [{ role: 'user', content: 'Open Chrome, search for Jarvin fixture result, and tell me what the visible result says.' }];
const settings = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 16384, temperature: 0.2, maxSteps: 8 } as Settings;
runAgent({
  settings, history, tools, system: `You are Jarvin. ${VISIBLE_CHROME_PROMPT}`,
  ctx: { root: process.cwd(), signal: AbortSignal.timeout(180_000) },
  approve: async () => true,
  emit: (event) => { if (event.type === 'tool_start') console.log(`Model requested: ${event.name}`); },
}).then((result) => {
  const answer = String([...history].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? '');
  if (result !== 'finished' || seen[0] !== 'chrome_search' || !seen.includes('focus_window') || !seen.includes('see_window') || seen.some((n) => ['desktop_inspect_window', 'web_search', 'web_fetch', 'research_web'].includes(n)) || !/blue/i.test(answer)) throw new Error(`Chrome routing did not complete correctly: ${JSON.stringify({ result, seen, answer })}`);
  console.log('Local model used visible Chrome routing and reported the simulated inspected result.');
}).catch((error) => { console.error(error); process.exitCode = 1; });
