import { parseTags, parsePullLine, validModelName, type LocalModel, type PullProgress } from '../shared/models';

const base = (u: string) => (u || 'http://127.0.0.1:11434').replace(/\/+$/, '');

export interface OllamaStatus {
  up: boolean;
  version?: string;
  error?: string;
}

export async function ollamaStatus(baseUrl: string): Promise<OllamaStatus> {
  try {
    const res = await fetch(`${base(baseUrl)}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { up: false, error: `Ollama answered ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as { version?: string };
    return { up: true, version: j.version };
  } catch (e: any) {
    return { up: false, error: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

export async function localModels(baseUrl: string): Promise<LocalModel[]> {
  const res = await fetch(`${base(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  return parseTags(await res.json());
}

const pulls = new Map<string, AbortController>();
export const pulling = () => [...pulls.keys()];

/** Downloads a model through Ollama, reporting progress. One download per name at a time. */
export async function pullModel(baseUrl: string, name: string, onProgress: (p: PullProgress) => void): Promise<PullProgress> {
  if (!validModelName(name)) throw new Error('That is not a valid model name.');
  if (pulls.has(name)) throw new Error(`${name} is already downloading.`);
  const ac = new AbortController();
  pulls.set(name, ac);
  let last: PullProgress = { name, status: 'starting' };
  try {
    onProgress(last);
    const res = await fetch(`${base(baseUrl)}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, name, stream: true }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      let msg = body.slice(0, 200);
      try { msg = JSON.parse(body).error ?? msg; } catch { /* keep text */ }
      throw new Error(msg || `Ollama returned ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const feed = (line: string) => {
      const p = parsePullLine(name, line);
      if (!p) return;
      last = p;
      onProgress(p);
      if (p.error) throw new Error(p.error);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        feed(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    feed(buf);
    if (!last.done) throw new Error('The download ended before Ollama said it was finished.');
    return last;
  } catch (e: any) {
    if (ac.signal.aborted) {
      const p: PullProgress = { name, status: 'cancelled', done: true, error: 'Cancelled.' };
      onProgress(p);
      return p;
    }
    const p: PullProgress = { name, status: 'error', done: true, error: String(e?.message ?? e) };
    onProgress(p);
    return p;
  } finally {
    pulls.delete(name);
  }
}

export function cancelPull(name: string): boolean {
  const ac = pulls.get(name);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function cancelAllPulls() {
  for (const ac of pulls.values()) ac.abort();
}

export async function deleteModel(baseUrl: string, name: string): Promise<void> {
  if (!validModelName(name)) throw new Error('That is not a valid model name.');
  if (pulls.has(name)) throw new Error(`${name} is still downloading. Cancel it first.`);
  const res = await fetch(`${base(baseUrl)}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, name }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body.slice(0, 200);
    try { msg = JSON.parse(body).error ?? msg; } catch { /* keep text */ }
    throw new Error(msg || `Ollama returned ${res.status}`);
  }
}
