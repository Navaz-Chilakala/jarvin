/** Image-only test on a generated desktop; never captures or controls the user's desktop. */
import fs from 'node:fs';
import sharp from 'sharp';
import { VisualGrounding, type ScreenFrame } from '../src/main/visual-grounding';
import { inspectWithOllama } from '../src/main/vision';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="900"><rect width="1500" height="900" fill="#dce6ef"/>
<rect x="10" y="10" width="1480" height="820" rx="14" fill="#f6f8fb"/><rect x="10" y="10" width="1480" height="44" fill="#172b40"/><text x="35" y="39" fill="white" font-family="Arial" font-size="20">Jarvin Docs — notes.txt</text>
<circle cx="65" cy="105" r="29" fill="#236ce7"/><path d="M55 88L80 105L55 122Z" fill="white"/><text x="110" y="114" font-size="29" font-family="Arial" fill="#19364c">Jarvin Docs</text>
<rect x="30" y="165" width="220" height="620" rx="12" fill="#e9edf5"/><text x="60" y="220" font-family="Arial" font-size="24">Overview</text><rect x="45" y="257" width="190" height="48" rx="8" fill="#d2e3ff"/><text x="60" y="289" font-family="Arial" font-size="24">Notes</text><text x="60" y="355" font-family="Arial" font-size="24">Projects</text>
<text x="310" y="220" font-size="35" font-family="Arial" fill="#162d40">Jarvin Handbook</text>
<text x="310" y="300" font-size="24" font-family="Arial">Jarvin can open applications and read the screen.</text>
<text x="310" y="395" font-size="24" font-family="Arial">The launch code is ORBIT-742. Keep this paragraph visible.</text>
<text x="310" y="490" font-size="24" font-family="Arial">Use the sidebar to switch between your notes and projects.</text>
<rect x="310" y="570" width="170" height="60" rx="10" fill="#24755d"/><text x="355" y="610" font-size="24" font-family="Arial" fill="white">Export</text>
<rect x="0" y="840" width="1500" height="60" fill="#172b40"/><g fill="#4dc6ff"><rect x="724" y="855" width="15" height="15"/><rect x="742" y="855" width="15" height="15"/><rect x="724" y="873" width="15" height="15"/><rect x="742" y="873" width="15" height="15"/></g><text x="1380" y="877" font-family="Arial" font-size="20" fill="white">09:42</text></svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();
fs.mkdirSync('.test-out', { recursive: true }); fs.writeFileSync('.test-out/vision-comparison.png', png);
const frame: ScreenFrame = { image: png.toString('base64'), fingerprint: new Uint8Array(64).fill(80), width: 1500, height: 900, displayId: 'fixture' };
const output: any[] = [];
for (const model of process.argv.slice(2).length ? process.argv.slice(2) : ['qwen3.5:4b', 'qwen3-vl:4b-instruct']) {
  const ask = (question: string) => inspectWithOllama({ baseUrl: 'http://127.0.0.1:11434', model, image: frame.image, question, signal: AbortSignal.timeout(120000) });
  for (const [target, rect] of [
    ['the Windows logo in the taskbar at the bottom', [714, 847, 766, 896]],
    ['the large blue circular logo beside Jarvin Docs', [30, 70, 100, 140]],
    ['the second paragraph beginning The launch code', [300, 365, 1150, 415]],
    ['the Notes navigation item in the left sidebar', [40, 250, 240, 310]],
  ] as const) {
    const start = Date.now(); let item; let raw = '';
    try {
      const grounding = new VisualGrounding(); const located = JSON.parse(await grounding.locate(frame, target, async question => (raw = await ask(question))));
      const point = grounding.consume(located.target_id, frame);
      const [l, t, r, b] = rect; item = { model, target, ...point, pass: point.x >= l && point.x <= r && point.y >= t && point.y <= b, seconds: (Date.now() - start) / 1000 };
    } catch (error) { item = { model, target, pass: false, raw, error: String(error), seconds: (Date.now() - start) / 1000 }; }
    output.push(item); console.log(JSON.stringify(item));
  }
  for (const [question, expected] of [
    ['Read only the launch code in the second paragraph.', /ORBIT-742/i],
    ['Is there a purple Save button in this image? Answer only yes or no.', /^no\b/i],
  ] as const) {
    const start = Date.now(); const answer = await ask(question); const item = { model, question, answer, pass: expected.test(answer.trim()), seconds: (Date.now() - start) / 1000 }; output.push(item); console.log(JSON.stringify(item));
  }
}
fs.mkdirSync('.test-out', { recursive: true }); fs.writeFileSync('.test-out/vision-model-comparison.json', JSON.stringify(output, null, 2));
for (const model of [...new Set(output.map(r => r.model))]) console.log(JSON.stringify({ model, passed: output.filter(r => r.model === model && r.pass).length, total: output.filter(r => r.model === model).length }));
