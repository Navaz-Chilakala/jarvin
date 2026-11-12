export interface ToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, any> };
}

export interface OMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: ToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}

export async function listModels(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const j = (await res.json()) as { models?: { name: string }[] };
  return (j.models ?? []).map((m) => m.name);
}

export interface ChatOpts {
  baseUrl: string;
  model: string;
  messages: OMsg[];
  tools: unknown[];
  numCtx: number;
  temperature: number;
  signal: AbortSignal;
  onToken: (t: string) => void;
}

/** Streams one assistant turn from Ollama's /api/chat and returns text plus any tool calls. */
export interface Usage { promptTokens?: number; completionTokens?: number }

/**
 * Ollama reloads a model whenever a request asks for a different context size (measured: about 8 s each way for
 * qwen3:8b, and the prompt cache is lost). So helper calls reuse the size the chat already loaded the model with.
 */
const loadedCtx = new Map<string, number>();
export function rememberModelContext(model: string, numCtx: number): void { if (model && numCtx > 0) loadedCtx.set(model, numCtx); }
export function helperContext(model: string, requested?: number): number { return loadedCtx.get(model) ?? requested ?? 4096; }

/**
 * Reads the system prompt and tool list into Ollama's prompt cache before the user's first request, which otherwise
 * pays for it (about 10 s on qwen3:8b). One token is generated and discarded. Returns the time taken in ms.
 */
export async function primeChat(o: { baseUrl: string; model: string; system: string; tools: unknown[]; numCtx: number; signal?: AbortSignal }): Promise<number> {
  const started = Date.now();
  rememberModelContext(o.model, o.numCtx);
  const res = await fetch(`${o.baseUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: o.signal ?? AbortSignal.timeout(120_000),
    body: JSON.stringify({ model: o.model, messages: [{ role: 'system', content: o.system }, { role: 'user', content: 'hi' }], tools: o.tools, stream: false, think: false, keep_alive: '15m', options: { num_ctx: o.numCtx, num_predict: 1 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  await res.json();
  return Date.now() - started;
}

let chatModel = '';
/** The model the agent last chatted with; screen reading prefers it when it can see, so no second model is loaded. */
export function lastChatModel(): string { return chatModel; }

export async function streamChat(o: ChatOpts): Promise<{ content: string; toolCalls: ToolCall[]; usage?: Usage }> {
  rememberModelContext(o.model, o.numCtx);
  chatModel = o.model;
  const res = await fetch(`${o.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: o.signal,
    body: JSON.stringify({
      model: o.model,
      messages: o.messages,
      tools: o.tools,
      stream: true,
      think: false,
      keep_alive: '15m',
      options: { num_ctx: o.numCtx, temperature: o.temperature },
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    if (/does not support tools/i.test(body))
      throw new Error(
        `Model "${o.model}" does not support tool calling. Choose a tool-capable model (e.g. qwen3, qwen2.5-coder, llama3.1).`,
      );
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls: ToolCall[] = [];
  let usage: Usage | undefined;

  const handle = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as { message?: { content?: string; tool_calls?: ToolCall[] }; error?: string; prompt_eval_count?: number; eval_count?: number };
    if (chunk.error) throw new Error(chunk.error);
    if (typeof chunk.prompt_eval_count === 'number' || typeof chunk.eval_count === 'number') usage = { promptTokens: chunk.prompt_eval_count, completionTokens: chunk.eval_count };
    const m = chunk.message;
    if (!m) return;
    if (m.content) {
      content += m.content;
      o.onToken(m.content);
    }
    for (const tc of m.tool_calls ?? []) {
      let args: any = tc.function.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      toolCalls.push({ function: { name: tc.function.name, arguments: args ?? {} } });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  handle(buf);
  return { content, toolCalls, usage };
}

/** One non-streaming chat call, used for small helper jobs such as dictation cleanup. */
export async function chatOnce(o: { baseUrl: string; model: string; messages: OMsg[]; timeoutMs: number; numCtx?: number; signal?: AbortSignal }): Promise<string> {
  const call = async (think: boolean) => {
    const res = await fetch(`${o.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]) : AbortSignal.timeout(o.timeoutMs),
      body: JSON.stringify({
        model: o.model,
        messages: o.messages,
        stream: false,
        ...(think ? {} : { think: false }),
        keep_alive: '15m',
        options: { num_ctx: helperContext(o.model, o.numCtx), temperature: 0.1 },
      }),
    });
    if (!res.ok) throw Object.assign(new Error(`Ollama ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`), { status: res.status });
    return ((await res.json()) as { message?: { content?: string } }).message?.content ?? '';
  };
  try {
    return await call(false);
  } catch (e: any) {
    if (e?.status === 400 && /think/i.test(String(e.message))) return call(true);
    throw e;
  }
}
