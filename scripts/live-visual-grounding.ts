/** Local model visual-coordinate check on generated test images, never the user's desktop. */
import sharp from 'sharp';
import { inspectWithOllama } from '../src/main/vision';
import { VisualGrounding, type ScreenFrame } from '../src/main/visual-grounding';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600">
<rect width="1000" height="600" fill="#f1f5f9"/><rect x="50" y="45" width="900" height="510" rx="20" fill="white" stroke="#ccd5df"/>
<text x="90" y="110" font-family="Arial" font-size="32" fill="#1e293b">Jarvin visual test</text>
<rect x="100" y="200" width="210" height="90" rx="12" fill="#2266c4"/><text x="205" y="257" text-anchor="middle" font-family="Arial" font-size="28" fill="white">BLUE</text>
<rect x="680" y="360" width="220" height="90" rx="12" fill="#c22d45"/><text x="790" y="417" text-anchor="middle" font-family="Arial" font-size="28" fill="white">RED</text>
</svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();
let passed = 0;
for (const target of [{ name: 'BLUE', rect: [100, 200, 310, 290] }, { name: 'RED', rect: [680, 360, 900, 450] }]) {
  const frame: ScreenFrame = { image: png.toString('base64'), fingerprint: new Uint8Array(64).fill(80), displayId: 'test', width: 1000, height: 600 };
  const grounding = new VisualGrounding();
  const located = JSON.parse(await grounding.locate(frame, `${target.name} button`, (question) => inspectWithOllama({ baseUrl: 'http://127.0.0.1:11434', model: process.env.JARVIN_TEST_VISION_MODEL || 'qwen3.5:4b', image: frame.image, question, signal: AbortSignal.timeout(120_000) })));
  const { x, y } = grounding.consume(located.target_id, frame);
  const [left, top, right, bottom] = target.rect;
  const ok = x >= left && x <= right && y >= top && y <= bottom;
  if (ok) passed++;
  console.log(`${target.name}: ${x},${y}; inside button: ${ok}`);
}
if (passed !== 2) throw new Error(`Visual grounding succeeded for ${passed}/2 controlled targets.`);
console.log('Local model identified both test button coordinates. This does not establish reliability on real apps.');
