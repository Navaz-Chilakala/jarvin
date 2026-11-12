import { esc } from './markdown';

export const MAX_DIAGRAM_CHARS = 20_000;
export const MAX_DIAGRAMS = 6;

let loading: Promise<any> | null = null;
let seq = 0;

/** Loads the Mermaid script the build copied next to the app. Resolves to null when it is not installed. */
function loadMermaid(): Promise<any> {
  const w = window as any;
  if (w.mermaid) return Promise.resolve(w.mermaid);
  loading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'mermaid.min.js';
    s.onload = () => {
      try {
        w.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
          flowchart: { htmlLabels: false },
          fontFamily: 'inherit',
        });
        resolve(w.mermaid);
      } catch {
        resolve(null);
      }
    };
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return loading;
}

const firstLine = (e: unknown) => String((e as any)?.message ?? e).split('\n').find((l) => l.trim())?.slice(0, 200) ?? 'unknown error';

function save(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Turns finished ```mermaid blocks inside `root` into drawn diagrams. Blocks that fail stay as readable code with a note. */
export async function renderDiagrams(root: HTMLElement, toast: (m: string) => void = () => {}): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('.code.mmd:not([data-mmd])')].slice(0, MAX_DIAGRAMS);
  if (!blocks.length) return;
  for (const b of blocks) b.dataset.mmd = 'wait';
  const mermaid = await loadMermaid();
  for (const block of blocks) {
    const src = (block.querySelector('code')?.textContent ?? '').trim();
    const note = (msg: string) => {
      block.dataset.mmd = 'failed';
      block.insertAdjacentHTML('beforeend', `<div class="mmdnote">${esc(msg)}</div>`);
    };
    if (!mermaid) { note('The diagram engine is not installed, so this is shown as text. Run npm install in the Jarvin folder, then restart.'); continue; }
    if (!src) { block.dataset.mmd = 'failed'; continue; }
    if (src.length > MAX_DIAGRAM_CHARS) { note('This diagram is too large to draw.'); continue; }
    const id = `mmd${++seq}`;
    try {
      await mermaid.parse(src);
      const { svg } = await mermaid.render(id, src);
      const box = document.createElement('div');
      box.className = 'mmdbox';
      box.dataset.mmd = 'done';
      box.innerHTML = `<div class="mmdsvg">${svg}</div><div class="mmdtools"><button type="button" data-a="copy">Copy source</button><button type="button" data-a="svg">Save SVG</button><button type="button" data-a="src">Show source</button></div>`;
      const pre = document.createElement('pre');
      pre.className = 'mmdsrc';
      pre.hidden = true;
      pre.textContent = src;
      box.appendChild(pre);
      box.addEventListener('click', async (e) => {
        const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
        if (a === 'copy') { try { await navigator.clipboard.writeText(src); toast('Diagram source copied'); } catch { toast('Could not copy'); } }
        else if (a === 'svg') save('diagram.svg', svg, 'image/svg+xml');
        else if (a === 'src') { pre.hidden = !pre.hidden; (e.target as HTMLElement).textContent = pre.hidden ? 'Show source' : 'Hide source'; }
      });
      block.replaceWith(box);
    } catch (e) {
      document.getElementById(`d${id}`)?.remove();
      note(`Could not draw this diagram: ${firstLine(e)}`);
    }
  }
}
