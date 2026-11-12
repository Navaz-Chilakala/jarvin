import { build } from 'esbuild';
import fs from 'node:fs';

const common = { bundle: true, sourcemap: true, logLevel: 'info', loader: { '.css': 'empty', '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty', '.svg': 'empty', '.png': 'empty' } };
const node = { ...common, platform: 'node', format: 'cjs', target: 'node20', external: ['electron', 'node-pty', 'electron-updater'] };

await Promise.all([
  build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js' }),
  build({ ...node, entryPoints: ['src/main/crash-watch.ts'], outfile: 'dist/crash-watch.js' }),
  build({ ...node, entryPoints: ['src/main/office-worker.ts'], outfile: 'dist/office-worker.js', packages: 'external' }),
  build({ ...node, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js' }),
  build({ ...node, entryPoints: ['src/main/overlay-preload.ts'], outfile: 'dist/overlay-preload.js' }),
  build({ ...node, entryPoints: ['src/main/assistant-widget-preload.ts'], outfile: 'dist/assistant-widget-preload.js' }),
  build({ ...node, entryPoints: ['src/main/live-screen-preload.ts'], outfile: 'dist/live-screen-preload.js' }),
  build({ ...node, entryPoints: ['src/main/preview-preload.ts'], outfile: 'dist/preview-preload.js' }),
  build({
    ...node,
    entryPoints: ['src/main/stt-worker.ts'],
    outfile: 'dist/stt-worker.js',
    external: ['electron', '@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web', 'sharp', 'sherpa-onnx-node'],
  }),
  build({ ...node, entryPoints: ['src/main/piper-worker.ts'], outfile: 'dist/piper-worker.js', external: ['onnxruntime-node', 'phonemizer', 'sherpa-onnx-node'] }),
  build({
    ...node,
    entryPoints: ['src/main/doc-worker.ts'],
    outfile: 'dist/doc-worker.js',
    external: ['electron', 'pdf-parse', 'mammoth', 'tesseract.js', '@tesseract.js-data/eng'],
  }),
  build({ ...common, entryPoints: ['src/renderer/preview.ts'], outfile: 'dist/renderer/preview.js', platform: 'browser', format: 'iife', target: 'chrome120' }),
  build({ ...common, entryPoints: ['src/renderer/overlay.ts'], outfile: 'dist/renderer/overlay.js', platform: 'browser', format: 'iife', target: 'chrome120' }),
  build({ ...common, entryPoints: ['src/renderer/assistant-widget.ts'], outfile: 'dist/renderer/assistant-widget.js', platform: 'browser', format: 'iife', target: 'chrome120' }),
  build({ ...common, entryPoints: ['src/renderer/live-screen.ts'], outfile: 'dist/renderer/live-screen.js', platform: 'browser', format: 'iife', target: 'chrome120' }),
  build({
    ...common,
    entryPoints: ['src/renderer/renderer.ts'],
    outfile: 'dist/renderer/renderer.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  }),
]);

fs.mkdirSync('dist/renderer', { recursive: true });
fs.copyFileSync('src/main/windows-uia.ps1', 'dist/windows-uia.ps1');
for (const f of ['index.html', 'styles.css', 'overlay.html', 'overlay.css', 'preview.html', 'preview.css', 'assistant-widget.html', 'assistant-widget.css', 'pet.png', 'live-screen.html', 'companion.svg', 'mic-worklet.js']) fs.copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);
// Optional pet poses: the pet falls back to pet.png for any that are missing.
for (const f of ['pet-wave.png', 'pet-listen.png', 'pet-think.png']) if (fs.existsSync(`src/renderer/${f}`)) fs.copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);
fs.copyFileSync('node_modules/monaco-editor/min/vs/editor/editor.main.css', 'dist/renderer/monaco.css');
fs.copyFileSync('node_modules/xterm/css/xterm.css', 'dist/renderer/xterm.css');
// Diagrams: optional. Without `npm install` of mermaid, chat shows the diagram text instead.
if (fs.existsSync('node_modules/mermaid/dist/mermaid.min.js')) fs.copyFileSync('node_modules/mermaid/dist/mermaid.min.js', 'dist/renderer/mermaid.min.js');
const fontPath = 'node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf';
if (fs.existsSync(fontPath)) fs.copyFileSync(fontPath, 'dist/renderer/codicon.ttf');
for (const w of ['editor', 'ts', 'json', 'css', 'html']) {
  const entry = w === 'editor'
    ? 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'
    : w === 'ts'
      ? 'node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js'
      : `node_modules/monaco-editor/esm/vs/language/${w}/${w}.worker.js`;
  const out = w === 'editor' ? 'dist/renderer/editor.worker.js' : `dist/renderer/${w === 'ts' ? 'ts' : w}.worker.js`;
  if (fs.existsSync(entry)) await build({ ...common, entryPoints: [entry], outfile: out, platform: 'browser', format: 'esm', target: 'chrome120' });
}
