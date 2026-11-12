/** Measures model choice only; no generated tool calls are executed. */
import fs from 'node:fs';
import { builtinTools } from '../src/main/tools';
import { streamChat } from '../src/main/ollama';
import { routeToolNames } from '../src/shared/tool-routing';

async function main() {
const baseUrl = 'http://127.0.0.1:11434';
const cases = ['Click the blue logo on my screen.', 'Type hello world in the focused text box.', 'Tell me briefly what you can help with.'];
const results: any[] = [];
for (const request of cases) {
  const start = performance.now(); let first = 0;
  const all = builtinTools.filter(t => !['desktop_inspect_window', 'desktop_control', 'mouse_click'].includes(t.name));
  const selected = new Set(routeToolNames(all.map(t => t.name), 'assistant', request));
  const tools = process.argv.includes('--routed') ? all.filter(t => selected.has(t.name)) : all;
  const result = await streamChat({ baseUrl, model: 'qwen3.5:4b', numCtx: 16384, temperature: 0, signal: AbortSignal.timeout(120000), onToken: () => { first ||= performance.now(); },
    messages: [{ role: 'system', content: 'You are Jarvin, a concise Windows voice companion. Use screenshot-based vision to see before acting. Use locate_screen_target then click_visual_target for clicking visible targets. Use keyboard_type for typing. Never guess coordinates. Use tools to perform requests; do not just explain them.' }, { role: 'user', content: request }],
    tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  });
  const row = { request, seconds: (performance.now() - start) / 1000, firstTextSeconds: first ? (first - start) / 1000 : null, toolCount: tools.length, calls: result.toolCalls.map(t => t.function), content: result.content, usage: result.usage };
  console.log(JSON.stringify(row)); results.push(row);
}
fs.writeFileSync(`.test-out/local-model-latency${process.argv.includes('--routed') ? '-routed' : ''}.json`, JSON.stringify(results, null, 2));
console.log('Loaded models:', JSON.stringify(await (await fetch(`${baseUrl}/api/ps`)).json()));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
