import { chooseVisionModel } from './vision';
import { rememberModelContext } from './ollama';

/** Preload installed local models, without transmitting any prompt or image. */
export async function warmCompanionModels(o: { baseUrl: string; model: string; visionModel?: string; numCtx: number; signal: AbortSignal }): Promise<string[]> {
  const url = new URL(o.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) return [];
  const base = url.href.replace(/\/+$/, '');
  const response = await fetch(`${base}/api/tags`, { signal: o.signal, redirect: 'error' });
  if (!response.ok) return [];
  const { models = [] } = await response.json() as { models?: { name: string; remote_host?: string; capabilities?: string[] }[] };
  const chat = models.find(m => m.name === o.model && !m.remote_host);
  if (!chat) return [];
  const vision = chooseVisionModel(models, o.visionModel || '', chat.name);
  // The chat model is warmed last. When both models do not fit in VRAM, Ollama unloads the earlier one, and the
  // first request is almost always chat (measured: 9 s to reload qwen3:8b after the vision model pushed it out).
  const selected = [{ name: chat.name, context: o.numCtx }];
  if (vision && !vision.remote_host && vision.name !== chat.name && vision.name) selected.unshift({ name: vision.name, context: 4096 });
  const ready: string[] = [];
  for (const model of selected) {
    const result = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: o.signal, redirect: 'error', body: JSON.stringify({ model: model.name, messages: [], stream: false, think: false, keep_alive: '15m', options: { num_ctx: model.context } }) });
    if (result.ok) { await result.json(); ready.push(model.name); rememberModelContext(model.name, model.context); }
  }
  return ready;
}
