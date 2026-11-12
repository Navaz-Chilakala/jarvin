import type { JarvinApi } from '../shared/types';
import { formatBytes } from '../shared/models';
import { extOf } from '../shared/images';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ATTACHABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_PER_MESSAGE = 4;

/** Image viewer for project files, and the small pictures the model can put in a chat reply. */
export function createImageUi(jarvin: JarvinApi, deps: { toast(m: string): void; attach(base64: string): void }) {
  let curPath = '';
  let curData = '';
  const cache = new Map<string, string>();

  async function load(rel: string): Promise<string> {
    const hit = cache.get(rel);
    if (hit) return hit;
    const url = await jarvin.readImage(rel);
    if (cache.size > 30) cache.delete(cache.keys().next().value as string);
    cache.set(rel, url);
    return url;
  }

  async function open(rel: string) {
    try {
      curData = await load(rel);
    } catch (e: any) {
      deps.toast(`Can't open ${rel.split('/').pop()}: ${String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
      return;
    }
    curPath = rel;
    const img = $<HTMLImageElement>('imgView');
    img.classList.add('fit');
    $('imgZoom').textContent = '100%';
    img.onload = () => {
      $('imgInfo').textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${formatBytes(Math.floor((curData.length - curData.indexOf(',') - 1) * 0.75))}`;
    };
    img.src = curData;
    img.alt = rel;
    $('imgName').textContent = rel;
    $<HTMLButtonElement>('imgAttach').hidden = !ATTACHABLE.has(extOf(rel));
    $<HTMLDialogElement>('imgDlg').showModal();
  }

  /** Fills in the pictures a reply points at. Only files inside the project load; web addresses never do. */
  async function hydrate(root: HTMLElement) {
    const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img.chatimg:not([data-done])'));
    for (const [i, el] of imgs.entries()) {
      el.dataset.done = '1';
      const rel = el.dataset.path ?? '';
      if (i >= MAX_PER_MESSAGE) {
        el.replaceWith(Object.assign(document.createElement('span'), { className: 'mmdnote', textContent: `[image not shown: ${rel}]` }));
        continue;
      }
      try {
        el.src = await load(rel);
        el.title = `${rel} — click to enlarge`;
        el.onclick = () => void open(rel);
      } catch {
        el.replaceWith(Object.assign(document.createElement('span'), { className: 'mmdnote', textContent: `[image not found: ${rel}]` }));
      }
    }
  }

  function wire() {
    $('imgZoom').onclick = () => {
      const img = $<HTMLImageElement>('imgView');
      const fit = img.classList.toggle('fit');
      $('imgZoom').textContent = fit ? '100%' : 'Fit';
    };
    $('imgAttach').onclick = () => {
      const i = curData.indexOf(',');
      if (i < 0) return;
      deps.attach(curData.slice(i + 1));
      deps.toast(`Attached ${curPath.split('/').pop()} to your next message`);
      $<HTMLDialogElement>('imgDlg').close();
    };
  }

  return { open, hydrate, wire, clear: () => cache.clear() };
}
