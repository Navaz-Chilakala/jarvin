import { randomUUID } from 'node:crypto';
import { type ChatOpts, type OMsg, type ToolCall } from './ollama';
export type { OMsg, ToolCall, ChatOpts };

let providerApiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '';
let ollamaModels = new Set<string>();
/** Names actually returned by Ollama take precedence over provider-style syntax. */
export function setOllamaModels(names: string[]) { ollamaModels = new Set(names); }
export function setProviderApiKey(key?: string) { if (typeof key === 'string' && key.trim()) providerApiKey = key.trim(); }
export const hasProviderApiKey = () => !!providerApiKey;

function isRemoteModel(model: string): boolean {
  return !ollamaModels.has(model) && (model.includes('/') || model.endsWith(':free'));
}

function toOpenAIMessages(msgs: OMsg[]): any[] {
  return msgs.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id || randomUUID(),
          type: 'function',
          function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments ?? {}) },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id || randomUUID() };
    }
    return { role: m.role, content: m.content, ...(m.images ? { images: m.images } : {}) };
  });
}

function openaiBaseUrl(model: string, fallback: string): string {
  if (isRemoteModel(model)) return 'https://openrouter.ai/api/v1';
  return (fallback || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

export async function streamChat(o: ChatOpts): Promise<{ content: string; toolCalls: ToolCall[]; usage?: { promptTokens?: number; completionTokens?: number } }> {
  if (!isRemoteModel(o.model)) {
    const { streamChat: ollamaStream } = await import('./ollama');
    return ollamaStream(o);
  }
  const token = providerApiKey;
  const baseUrl = openaiBaseUrl(o.model, o.baseUrl);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'HTTP-Referer': 'https://jarvin.local',
      'X-Title': 'Jarvin',
    },
    signal: o.signal,
    body: JSON.stringify({
      model: o.model,
      messages: toOpenAIMessages(o.messages),
      tools: o.tools,
      stream: true,
      temperature: o.temperature ?? 0.2,
    }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new Error(token
        ? `OpenRouter rejected your API key (${res.status}). Check it in Settings → API key.`
        : 'This is an OpenRouter cloud model and it needs an API key. Open Settings, paste a key into "OpenRouter/OpenAI API key" (free keys: openrouter.ai/keys), or pick a local Ollama model instead.');
    }
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const toolAcc: Record<number, { id?: string; name: string; args: string }> = {};
  let usage: { promptTokens?: number; completionTokens?: number } | undefined;
  const ensure = (i: number) => (toolAcc[i] ??= { name: '', args: '' });
  outer: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break outer;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(chunk.error?.message || JSON.stringify(chunk.error));
      if (chunk.usage && (typeof chunk.usage.prompt_tokens === 'number' || typeof chunk.usage.completion_tokens === 'number')) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) { content += delta.content; o.onToken(delta.content); }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const acc = ensure(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  }
  const toolCalls: ToolCall[] = Object.values(toolAcc).map((tc) => {
    let args: any = {};
    try { args = tc.args ? JSON.parse(tc.args) : {}; } catch { args = {}; }
    return { id: tc.id || randomUUID(), function: { name: tc.name, arguments: args ?? {} } };
  });
  return { content, toolCalls, usage };
}

export async function chatOnce(o: { baseUrl: string; model: string; messages: OMsg[]; timeoutMs: number; numCtx?: number; signal?: AbortSignal }): Promise<string> {
  const isRemote = isRemoteModel(o.model);
  if (!isRemote) {
    const { chatOnce: ollamaOnce } = await import('./ollama');
    return ollamaOnce(o);
  }
  const token = providerApiKey;
  const baseUrl = openaiBaseUrl(o.model, o.baseUrl);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) , 'HTTP-Referer': 'https://jarvin.local', 'X-Title': 'Jarvin' },
    signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]) : AbortSignal.timeout(o.timeoutMs),
    body: JSON.stringify({ model: o.model, messages: toOpenAIMessages(o.messages), stream: false, temperature: 0.1 }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}
