import type { JarvinApi } from '../shared/types';
import type { MemoryInfo } from '../main/memory';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function createMemoryUi(api: JarvinApi) {
  const dialog = element<HTMLDialogElement>('memoryDlg');
  const select = element<HTMLSelectElement>('memorySelect');
  const text = element<HTMLTextAreaElement>('memoryText');
  const status = element<HTMLElement>('memoryStatus');
  const meta = element<HTMLElement>('memoryMeta');
  const save = element<HTMLButtonElement>('memorySave');
  const remove = element<HTMLButtonElement>('memoryDelete');
  const close = element<HTMLButtonElement>('memoryClose');
  let items: MemoryInfo[] = [];
  let selected = '';
  let revision = '';
  let original = '';
  let busy = false;

  const dirty = () => !!selected && text.value !== original;
  const update = () => {
    select.disabled = busy || !items.length;
    text.disabled = busy || !selected;
    save.disabled = busy || !dirty();
    remove.disabled = busy || !selected;
    close.disabled = busy;
  };
  const error = (e: unknown) => { status.textContent = e instanceof Error ? e.message : String(e); };
  const canDiscard = () => !dirty() || window.confirm('Discard unsaved changes to this memory?');

  async function load(id: string) {
    selected = '';
    revision = '';
    original = '';
    text.value = '';
    meta.textContent = '';
    status.textContent = '';
    if (!id) { update(); return; }
    busy = true; update();
    try {
      const content = await api.memoryRead(id);
      selected = id;
      revision = content.revision;
      text.value = original = content.text;
      const info = items.find((m) => m.id === id);
      meta.textContent = [info?.description, info?.type].filter(Boolean).join(' · ');
    } catch (e) { error(e); }
    finally { busy = false; update(); }
  }

  async function refresh(preferred = '') {
    busy = true; update();
    try {
      items = await api.memoryList();
      select.replaceChildren();
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        select.append(option);
      }
      const id = items.some((item) => item.id === preferred) ? preferred : items[0]?.id || '';
      select.value = id;
      if (!id) status.textContent = 'No saved memories yet.';
      busy = false;
      if (id) await load(id);
      else { selected = ''; revision = ''; original = ''; text.value = ''; meta.textContent = ''; }
    } catch (e) { error(e); }
    finally { busy = false; update(); }
  }

  function wire() {
    element('memoryBtn').onclick = () => { dialog.showModal(); void refresh(); };
    close.onclick = () => { if (!busy && canDiscard()) dialog.close(); };
    dialog.addEventListener('cancel', (event) => { if (busy || !canDiscard()) event.preventDefault(); });
    select.onchange = () => {
      const next = select.value;
      if (!canDiscard()) { select.value = selected; return; }
      void load(next);
    };
    text.oninput = update;
    save.onclick = async () => {
      if (!selected || !dirty() || busy) return;
      busy = true; update();
      try {
        await api.memorySave(selected, revision, text.value);
        const content = await api.memoryRead(selected);
        revision = content.revision;
        text.value = original = content.text;
        status.textContent = 'Memory saved.';
      } catch (e) { error(e); }
      finally { busy = false; update(); }
    };
    remove.onclick = async () => {
      if (!selected || busy) return;
      const name = items.find((m) => m.id === selected)?.name ?? selected;
      if (!window.confirm(`Delete the saved memory “${name}”?`)) return;
      busy = true; update();
      try { await api.memoryDelete(selected, revision); selected = ''; revision = ''; original = ''; text.value = ''; await refresh(); }
      catch (e) { error(e); }
      finally { busy = false; update(); }
    };
  }
  return { wire };
}
