import type { JarvinApi, ModelsDetails, Settings } from '../shared/types';
import { RECOMMENDED, formatBytes, isEmbeddingModel, isRemoteModelId, pickDefaultModel, setupStage, suggestChatModel, validModelName, type PullProgress } from '../shared/models';
import { esc } from './markdown';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface ModelUiDeps {
  getSettings(): Settings;
  setSettings(patch: Partial<Settings>): Promise<void>;
  /** Reloads the model drop-down in the header. */
  reloadModels(): Promise<void>;
  openWorkspace(): Promise<void>;
  toast(msg: string): void;
}

/** The Models screen and the first-run guide. Both share one download tracker. */
export function createModelUi(jarvin: JarvinApi, deps: ModelUiDeps) {
  const progress = new Map<string, PullProgress>();
  let details: ModelsDetails | null = null;
  let tab: 'local' | 'cloud' = 'local';

  const bar = (name: string) => {
    const p = progress.get(name);
    if (!p) return '';
    const pct = p.pct ?? 0;
    const label = p.error ? esc(p.error) : p.pct !== undefined ? `${esc(p.status)} ${pct}%` : esc(p.status || 'working');
    return `<div class="mdprog${p.error ? ' bad' : ''}" data-n="${esc(name)}"><div class="mdfill" style="width:${pct}%"></div><span>${label}</span></div>`;
  };

  async function fetchDetails() {
    try {
      details = await jarvin.modelsDetails();
    } catch (e: any) {
      details = { ollama: { up: false, error: String(e?.message ?? e) }, models: [], pulling: [], hasKey: false, ramGB: 8, baseUrl: deps.getSettings().baseUrl, offline: false };
    }
    return details;
  }

  const downloading = (name: string) => {
    const p = progress.get(name);
    return !!p && !p.done;
  };

  // ---------- Models screen ----------
  function renderModels() {
    const d = details;
    if (!d) return;
    const s = deps.getSettings();
    $('mdStatus').innerHTML = d.ollama.up
      ? `<span class="good">● Ollama ${esc(d.ollama.version ?? '')} is running</span> <span class="hint">at ${esc(d.baseUrl)} · this PC has about ${d.ramGB} GB of memory</span>`
      : `<span class="bad">● Cannot reach Ollama at ${esc(d.baseUrl)}</span> <span class="hint">Start the Ollama app, or <a href="#" id="mdGet">download it</a>.</span>`;
    $('mdGet')?.addEventListener('click', (e) => { e.preventDefault(); void jarvin.openExternal('https://ollama.com/download'); });

    const rows = d.models.map((m) => {
      const using = s.model === m.name;
      const meta = [m.remoteHost ? `Cloud via ${m.remoteHost}` : formatBytes(m.size), m.params, m.quant].filter(Boolean).join(' · ');
      const embed = isEmbeddingModel(m.name);
      return `<div class="mdrow" data-name="${esc(m.name)}"><div class="mdinfo"><b>${esc(m.name)}</b>${using ? ' <span class="mdtag">in use</span>' : ''}${embed ? ' <span class="mdtag dim">embedding</span>' : ''}<div class="hint">${esc(meta)}</div></div>` +
        `<button type="button" class="btn small" data-a="use"${using || embed ? ' disabled' : ''}>Use</button><button type="button" class="btn small danger" data-a="del">Delete</button></div>`;
    });
    $('mdInstalled').innerHTML = rows.join('') || `<div class="hint">${d.ollama.up ? 'No models yet. Download one below.' : 'Ollama is not running, so installed models cannot be listed.'}</div>`;

    const have = new Set(d.models.map((m) => m.name));
    const sug = suggestChatModel(d.ramGB).name;
    $('mdRec').innerHTML = RECOMMENDED.map((r) => {
      const got = have.has(r.name) || have.has(r.name + ':latest');
      const fits = r.ramGB <= d.ramGB;
      const busy = downloading(r.name);
      return `<div class="mdrow" data-name="${esc(r.name)}"><div class="mdinfo"><b>${esc(r.label)}</b> <span class="hint">${esc(r.name)} · ${r.gb} GB</span>${r.name === sug ? ' <span class="mdtag">suggested for this PC</span>' : ''}` +
        `<div class="hint">${esc(r.note)}${fits ? '' : ' May be slow on this PC.'}</div>${bar(r.name)}</div>` +
        (busy ? `<button type="button" class="btn small" data-a="cancel">Cancel</button>` : got ? `<span class="hint">installed</span>` : `<button type="button" class="btn small primary" data-a="pull"${d.ollama.up ? '' : ' disabled'}>Download</button>`) + `</div>`;
    }).join('');
    // Downloads of other names (typed in) show up here too.
    const extra = [...progress.values()].filter((p) => !RECOMMENDED.some((r) => r.name === p.name) && (!p.done || p.error));
    $('mdOther').innerHTML = extra.map((p) => `<div class="mdrow" data-name="${esc(p.name)}"><div class="mdinfo"><b>${esc(p.name)}</b>${bar(p.name)}</div>${p.done ? '' : '<button type="button" class="btn small" data-a="cancel">Cancel</button>'}</div>`).join('');
    $('mdOffline').hidden = !d.offline;
  }

  async function startPull(name: string) {
    if (!validModelName(name)) return deps.toast('That is not a valid model name.');
    if (downloading(name)) return;
    progress.set(name, { name, status: 'starting' });
    renderAll();
    try {
      const r = await jarvin.modelsPull(name);
      progress.set(name, r);
      if (r.error && r.status !== 'cancelled') deps.toast(`Download failed: ${r.error}`);
      if (r.status === 'cancelled') progress.delete(name);
    } catch (e: any) {
      progress.set(name, { name, status: 'error', error: String(e?.message ?? e), done: true });
      deps.toast(String(e?.message ?? e));
    }
    await afterChange(name);
  }

  /** After a download or delete: refresh lists, and use the new model if there was no usable one. */
  async function afterChange(pulled?: string) {
    await fetchDetails();
    const p = pulled ? progress.get(pulled) : undefined;
    if (pulled && p?.done && !p.error) {
      progress.delete(pulled);
      const s = deps.getSettings();
      const chatOk = details!.models.some((m) => m.name === s.model) || (!!s.model && isRemoteModelId(s.model) && details!.hasKey);
      if (!chatOk && !isEmbeddingModel(pulled) && details!.models.some((m) => m.name === pulled || m.name === pulled + ':latest')) {
        await deps.setSettings({ model: details!.models.find((m) => m.name === pulled || m.name === pulled + ':latest')!.name });
      }
    }
    await deps.reloadModels();
    renderAll();
  }

  const renderAll = () => {
    if ($<HTMLDialogElement>('modelDlg').open) renderModels();
    if ($<HTMLDialogElement>('setupDlg').open) renderSetup();
  };

  async function openModels() {
    $<HTMLDialogElement>('modelDlg').showModal();
    $('mdStatus').textContent = 'Checking Ollama…';
    await fetchDetails();
    renderModels();
  }

  async function onListClick(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
    const row = (e.target as HTMLElement).closest<HTMLElement>('.mdrow');
    if (!btn || !row?.dataset.name) return;
    const name = row.dataset.name;
    const a = btn.dataset.a;
    if (a === 'pull') void startPull(name);
    else if (a === 'cancel') await jarvin.modelsCancel(name);
    else if (a === 'use') {
      await deps.setSettings({ model: name });
      await deps.reloadModels();
      renderModels();
    } else if (a === 'del') {
      if (btn.dataset.sure !== '1') {
        btn.dataset.sure = '1';
        btn.textContent = 'Really delete?';
        setTimeout(() => { if (btn.isConnected) { btn.dataset.sure = ''; btn.textContent = 'Delete'; } }, 4000);
        return;
      }
      try {
        await jarvin.modelsDelete(name);
        deps.toast(`Deleted ${name}`);
      } catch (err: any) {
        deps.toast(String(err?.message ?? err));
      }
      await afterChange();
    }
  }

  // ---------- First-run guide ----------
  function renderSetup() {
    const d = details;
    const s = deps.getSettings();
    $('suTabLocal').classList.toggle('on', tab === 'local');
    $('suTabCloud').classList.toggle('on', tab === 'cloud');
    $('suLocal').hidden = tab !== 'local';
    $('suCloud').hidden = tab !== 'cloud';
    $('suWs').textContent = s.workspace || 'No folder yet';
    if (!d) return;
    const localNames = d.models.map((m) => m.name);
    const stage = setupStage({ ollamaUp: d.ollama.up, localModels: localNames, hasKey: d.hasKey, model: s.model, workspace: s.workspace });
    const chatModels = d.models.filter((m) => !isEmbeddingModel(m.name));
    const sug = suggestChatModel(d.ramGB);

    const ok = (t: string) => `<span class="good">✓</span> ${t}`;
    const todo = (t: string) => `<span class="bad">●</span> ${t}`;
    $('suOllama').innerHTML = d.ollama.up
      ? ok(`Ollama is running${d.ollama.version ? ` (v${esc(d.ollama.version)})` : ''}.`)
      : todo(`Ollama isn't running. Install it, start it, then press Check again.`) + `<div class="row"><button type="button" class="btn small primary" id="suGet">Download Ollama</button><button type="button" class="btn small" id="suCheck">Check again</button></div>`;
    $('suGet')?.addEventListener('click', () => void jarvin.openExternal('https://ollama.com/download'));
    $('suCheck')?.addEventListener('click', async () => { $('suOllama').textContent = 'Checking…'; await fetchDetails(); renderSetup(); void deps.reloadModels(); });

    if (!d.ollama.up) {
      $('suModel').innerHTML = `<span class="hint">Next you pick a model.</span>`;
    } else if (chatModels.length) {
      const nonCloud = chatModels.filter((m) => !m.remoteHost).map((m) => m.name);
      const cur = chatModels.some((m) => m.name === s.model) ? s.model : pickDefaultModel(nonCloud.length ? nonCloud : localNames, false, localNames);
      $('suModel').innerHTML = ok(`Model: <select id="suPick">${chatModels.map((m) => `<option${m.name === cur ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`) + ` <button type="button" class="btn small" id="suMore">More models…</button>`;
      $('suPick').onchange = async () => { await deps.setSettings({ model: $<HTMLSelectElement>('suPick').value }); await deps.reloadModels(); renderSetup(); };
      if (s.model !== cur && stage !== 'model') void deps.setSettings({ model: cur }).then(() => deps.reloadModels());
    } else {
      const busy = downloading(sug.name);
      $('suModel').innerHTML = todo(`No model yet. Suggested for this PC (${d.ramGB} GB memory): <b>${esc(sug.label)}</b>, ${sug.gb} GB download.`) +
        (busy ? `<div class="row"><button type="button" class="btn small" id="suCancel">Cancel</button></div>${bar(sug.name)}` : `<div class="row"><button type="button" class="btn small primary" id="suPull">Download ${esc(sug.name)}</button><button type="button" class="btn small" id="suMore">Pick another…</button></div>${bar(sug.name)}`);
      $('suPull')?.addEventListener('click', () => void startPull(sug.name));
      $('suCancel')?.addEventListener('click', () => void jarvin.modelsCancel(sug.name));
    }
    $('suMore')?.addEventListener('click', () => void openModels());

    $('suKeyState').textContent = d.hasKey ? 'A key is saved. Cloud models appear in the model list.' : 'No key saved yet.';
    $('suFolder').innerHTML = s.workspace ? ok(`Folder: <code>${esc(s.workspace)}</code>`) : todo('Open the project folder you want Jarvin to work in.');
    $<HTMLButtonElement>('suDone').disabled = stage !== 'ready';
    $('suHint').textContent = stage === 'ready' ? 'All set.' : stage === 'folder' ? 'One more thing: open a folder.' : stage === 'model' ? 'Pick or download a model to continue.' : 'Start Ollama, or use a cloud key instead.';
  }

  async function openSetup() {
    const dlg = $<HTMLDialogElement>('setupDlg');
    dlg.showModal();
    await fetchDetails();
    tab = details!.hasKey && !details!.ollama.up ? 'cloud' : 'local';
    renderSetup();
  }

  /** Shows the guide on first launch, when something needed is missing. Existing, working setups are left alone. */
  async function maybeFirstRun() {
    const s = deps.getSettings();
    if (s.setupDone) return;
    const d = await fetchDetails();
    const stage = setupStage({ ollamaUp: d.ollama.up, localModels: d.models.map((m) => m.name), hasKey: d.hasKey, model: s.model, workspace: s.workspace });
    if (stage === 'ready') {
      await deps.setSettings({ setupDone: true });
      return;
    }
    await openSetup();
  }

  function wire() {
    $('mdInstalled').addEventListener('click', onListClick);
    $('mdRec').addEventListener('click', onListClick);
    $('mdOther').addEventListener('click', onListClick);
    $('mdRefresh').onclick = async () => { await fetchDetails(); renderModels(); };
    $('mdPull').onclick = () => {
      const name = $<HTMLInputElement>('mdName').value.trim();
      if (!validModelName(name)) return deps.toast('Type a model name such as llama3.1:8b');
      $<HTMLInputElement>('mdName').value = '';
      void startPull(name);
    };
    $('mdName').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('mdPull').click(); });
    $('mdLib').addEventListener('click', (e) => { e.preventDefault(); void jarvin.openExternal('https://ollama.com/library'); });

    $('suTabLocal').onclick = () => { tab = 'local'; renderSetup(); };
    $('suTabCloud').onclick = () => { tab = 'cloud'; renderSetup(); };
    $('suKeyGet').addEventListener('click', (e) => { e.preventDefault(); void jarvin.openExternal('https://openrouter.ai/keys'); });
    $('suKeySave').onclick = async () => {
      const key = $<HTMLInputElement>('suKey').value.trim();
      if (!key) return deps.toast('Paste a key first.');
      await deps.setSettings({ providerApiKey: key });
      $<HTMLInputElement>('suKey').value = '';
      await fetchDetails();
      await deps.reloadModels();
      const s = deps.getSettings();
      if (!s.model || !isRemoteModelId(s.model)) {
        const r = await jarvin.listModels();
        const pick = pickDefaultModel(r.models.filter(isRemoteModelId), true);
        if (pick) await deps.setSettings({ model: pick });
        await deps.reloadModels();
      }
      renderSetup();
    };
    $('suOpen').onclick = async () => { await deps.openWorkspace(); renderSetup(); };
    const finish = async () => { await deps.setSettings({ setupDone: true }); $<HTMLDialogElement>('setupDlg').close(); };
    $('suDone').onclick = () => void finish();
    $('suSkip').onclick = () => void finish();
    jarvin.onModelProgress((p) => {
      progress.set(p.name, p);
      const dlgOpen = $<HTMLDialogElement>('modelDlg').open || $<HTMLDialogElement>('setupDlg').open;
      if (!dlgOpen) return;
      // Update bars in place so buttons stay clickable while bytes arrive.
      document.querySelectorAll<HTMLElement>('.mdprog').forEach((el) => {
        if (el.dataset.n === p.name) el.outerHTML = bar(p.name);
      });
      if (!document.querySelector('.mdprog') && !p.done) renderAll();
    });
  }

  return { wire, openModels, openSetup, maybeFirstRun, refresh: renderAll };
}
