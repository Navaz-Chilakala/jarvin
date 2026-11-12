/** Real local model and visual grounding against a generated, simulated desktop only. */
import sharp from 'sharp';
import { runAgent } from '../src/main/agent';
import { builtinTools } from '../src/main/tools';
import { inspectWithOllama } from '../src/main/vision';
import { VisualGrounding, type ScreenFrame } from '../src/main/visual-grounding';
import { visualClick } from '../src/main/visual-action';
import type { Settings } from '../src/shared/types';
import { routeToolNames } from '../src/shared/tool-routing';

const signal = AbortSignal.timeout(180_000);
let clicked = false;
const visual = new VisualGrounding();
const seen: string[] = [];
async function picture() {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="#f1f5f9"/><rect x="50" y="45" width="900" height="510" rx="20" fill="white" stroke="#ccd5df"/><text x="100" y="130" font-family="Arial" font-size="32" fill="#1e293b">${clicked ? 'RESULT: BLUE ACTIVATED' : 'RESULT: WAITING'}</text><rect x="100" y="200" width="210" height="90" rx="12" fill="#2266c4"/><text x="205" y="257" text-anchor="middle" font-family="Arial" font-size="28" fill="white">BLUE</text></svg>`)).png().toBuffer();
}
async function frame(): Promise<ScreenFrame> { return { image: (await picture()).toString('base64'), fingerprint: new Uint8Array(64).fill(clicked ? 81 : 80), displayId: 'fixture', width: 1000, height: 600 }; }
const localVision = (image: string, question: string) => inspectWithOllama({ baseUrl: 'http://127.0.0.1:11434', model: process.env.JARVIN_TEST_VISION_MODEL || 'qwen3-vl:4b-instruct', image, question, signal });
const candidateTools = builtinTools.filter((t) => process.argv.includes('--full-tools') || process.argv.includes('--routed') ? !['desktop_inspect_window', 'desktop_control', 'mouse_click'].includes(t.name) : ['visual_click', 'inspect_screen'].includes(t.name));
const selectedTools = new Set(routeToolNames(candidateTools.map(t => t.name), 'assistant', 'Click the BLUE button on the screen, then look again and tell me the result.'));
const tools = candidateTools.filter(t => !process.argv.includes('--routed') || selectedTools.has(t.name)).map((tool) => ({
  ...tool,
  run: async (args: any) => {
    seen.push(tool.name);
    if (tool.name === 'visual_click') return visualClick(String(args.target), String(args.expected_result ?? ''), {
      visual, signal, frame: async () => frame(), pinForeground: async () => 'fixture', checkForeground: async () => {},
      click: async (_window, x, y) => {
        if (x < 100 || x > 310 || y < 200 || y > 290) throw new Error('The simulated click missed the button.');
        clicked = true; return 'Click sent.';
      },
      inspect: localVision, invalidate: () => {},
    });
    if (tool.name === 'locate_screen_target') { const f = await frame(); return visual.locate(f, String(args.target), (question) => localVision(f.image, question)); }
    if (tool.name === 'click_visual_target') {
      const point = visual.consume(args.target_id, await frame());
      if (point.x < 100 || point.x > 310 || point.y < 200 || point.y > 290) throw new Error('The simulated click missed the button.');
      clicked = true; return 'Click sent. Look again to verify.';
    }
    if (tool.name !== 'inspect_screen') throw new Error('This generated fixture only supports screenshot observation and visual clicks.');
    const f = await frame(); return localVision(f.image, 'Read the RESULT text in the image.');
  },
}));
const history: any[] = [{ role: 'user', content: 'Click the BLUE button on the screen, then look again and tell me the result.' }];
const settings = { baseUrl: 'http://127.0.0.1:11434', model: process.env.JARVIN_TEST_CHAT_MODEL || 'qwen3.5:4b', numCtx: 16384, temperature: 0.2, maxSteps: 8 } as Settings;
runAgent({ settings, history, tools, ctx: { root: process.cwd(), signal }, approve: async () => true,
  system: 'You are Jarvin. For a requested screen click, use visual_click with the expected visible result. It locates the target, sends real-style mouse input and examines the screen afterward. Never claim success without a confirming observation.',
  emit: (event) => { if (event.type === 'tool_start') console.log(`Model requested: ${event.name}`); },
}).then((result) => {
  const answer = String([...history].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? '');
  if (result !== 'finished' || !clicked || !seen.includes('visual_click') || !/blue/i.test(answer)) throw new Error(`Simulated visual workflow failed: ${JSON.stringify({ result, seen, clicked, answer })}`);
  console.log(JSON.stringify({ model: settings.model, seconds: Math.round(performance.now()) / 1000, calls: seen, result: answer }));
}).catch((error) => { console.error(error); process.exitCode = 1; });
