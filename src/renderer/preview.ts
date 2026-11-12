interface State { url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean; errors: number; auto: boolean; error?: string }
interface Pv {
  go(i: string): Promise<{ ok: boolean; error?: string }>;
  back(): Promise<void>; forward(): Promise<void>; reload(): Promise<void>; stop(): Promise<void>;
  devtools(): Promise<void>; external(): Promise<void>; auto(on: boolean): Promise<void>;
  servers(): Promise<number[]>; shot(): Promise<boolean>; console(): Promise<boolean>;
  onState(cb: (s: State) => void): void;
}
const pv = (window as unknown as { pv: Pv }).pv;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const url = $<HTMLInputElement>('url');
let flash = '';
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let last: State | null = null;
let lastErr: string | undefined;

function say(m: string) {
  flash = m;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = ''; if (last) paint(last); }, 3500);
  if (last) paint(last);
}

function paint(s: State) {
  if (s.error && s.error !== lastErr) flash = ''; // a new problem beats an old notice
  lastErr = s.error;
  last = s;
  if (document.activeElement !== url) url.value = s.url;
  $<HTMLButtonElement>('back').disabled = !s.canBack;
  $<HTMLButtonElement>('fwd').disabled = !s.canForward;
  $('reload').textContent = s.loading ? '✕' : '↻';
  $<HTMLInputElement>('auto').checked = s.auto;
  const st = $('status');
  const msg = flash || s.error || (s.loading ? 'Loading…' : s.title);
  st.textContent = msg;
  st.className = 'status' + (!flash && s.error ? ' bad' : '');
  const e = $<HTMLButtonElement>('errs');
  e.hidden = !s.errors;
  e.textContent = `${s.errors} console problem${s.errors === 1 ? '' : 's'} → chat`;
}

async function go(v: string) {
  const r = await pv.go(v);
  if (!r.ok) say(r.error ?? 'Could not open that.');
}

pv.onState(paint);
$('back').onclick = () => void pv.back();
$('fwd').onclick = () => void pv.forward();
$('reload').onclick = () => void (last?.loading ? pv.stop() : pv.reload());
$('go').onclick = () => void go(url.value);
url.onkeydown = (e) => { if (e.key === 'Enter') void go(url.value); };
url.onfocus = () => url.select();
$('auto').onchange = () => void pv.auto($<HTMLInputElement>('auto').checked);
$('dev').onclick = () => void pv.devtools();
$('ext').onclick = () => void pv.external();
$('shot').onclick = async () => {
  try { await pv.shot(); say('Screenshot sent to the chat.'); } catch (e: any) { say(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
};
$('errs').onclick = async () => { if (await pv.console()) say('Console problems sent to the chat.'); };

const servers = $<HTMLSelectElement>('servers');
async function refreshServers() {
  const ports = await pv.servers().catch(() => [] as number[]);
  servers.innerHTML = `<option value="">${ports.length ? `Servers (${ports.length})…` : 'No servers found'}</option>` + ports.map((p) => `<option value="${p}">localhost:${p}</option>`).join('');
}
servers.onfocus = () => void refreshServers();
servers.onchange = () => { if (servers.value) void go(servers.value); servers.value = ''; };
void refreshServers();
