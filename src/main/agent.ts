import { randomUUID } from 'node:crypto';
import { streamChat, chatOnce, type OMsg } from './openai';
import type { ToolCtx, ToolDef } from './tools';
import { redactSecrets } from './sandbox';
import type { AgentEvent, Settings } from '../shared/types';
import { isSimpleChromeLaunch } from './browser-policy';

export interface RunOpts {
  settings: Settings;
  system: string;
  history: OMsg[];
  tools: ToolDef[];
  ctx: ToolCtx;
  emit: (e: AgentEvent) => void;
  approve: (tool: ToolDef, args: any, id: string) => Promise<boolean>;
  /** Project hooks. `pre` returns a reason to block the call; `post` returns text to append to the tool result. */
  hooks?: {
    pre: (tool: string, args: any) => Promise<string | null>;
    post: (tool: string, args: any, ok: boolean) => Promise<string>;
  };
}

const MAX_TOOL_OUT = 20000;

/** An approval dialog must not keep a cancelled run alive. */
export async function waitForApproval(approval: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); resolve(false); };
    const cleanup = () => signal.removeEventListener('abort', stop);
    signal.addEventListener('abort', stop, { once: true });
    approval.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) stop();
  });
}

/** Batch streamed tool output into ~12 events a second. */
function liveOutput(id: string, emit: (e: AgentEvent) => void) {
  let pending = '';
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending) emit({ type: 'tool_output', id, text: pending });
    pending = '';
  };
  return {
    push(chunk: string) {
      pending += chunk;
      timer ??= setTimeout(flush, 80);
    },
    flush,
  };
}

/** Keep the prompt inside the context window by trimming the oldest large tool outputs first. */
function compact(msgs: OMsg[], budgetChars: number) {
  let total = msgs.reduce((n, m) => n + m.content.length, 0);
  for (const m of msgs) {
    if (total <= budgetChars) break;
    if (m.role === 'tool' && m.content.length > 400) {
      total -= m.content.length - 30;
      m.content = '[older tool output trimmed]';
    }
  }
}

async function compactHistory(o: RunOpts, emit: (e: any) => void): Promise<void> {
  const s = o.settings;
  const budget = (s.numCtx || 16384) * 3;
  const total = o.history.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  if (total <= Math.floor(budget * 0.75)) {
    compact(o.history, budget);
    return;
  }
  const keep = Math.min(8, o.history.length);
  if (o.history.length <= keep + 2) {
    compact(o.history, budget);
    return;
  }
  const older = o.history.slice(0, o.history.length - keep);
  const newer = o.history.slice(o.history.length - keep);
  const transcript = older
    .map((m) => `[${m.role}] ${(m.content ?? '').slice(0, 1500)}`)
    .join('\n');
  try {
    emit({ type: 'note', text: 'Compacting older context…' });
    const summary = await chatOnce({
      baseUrl: s.baseUrl,
      model: s.reasoningModel || s.model,
      messages: [
        { role: 'system', content: 'Summarize the conversation concisely, preserving facts, decisions, file paths and errors. Output only the summary.' },
        { role: 'user', content: transcript },
      ],
      timeoutMs: 30000,
      numCtx: Math.min(4096, s.numCtx || 4096),
      signal: o.ctx.signal,
    });
    if (o.ctx.signal.aborted) return;
    if (!summary.trim()) throw new Error('Context summary was empty.');
    o.history.length = 0;
    o.history.push({ role: 'assistant', content: `[Summary of earlier turns]\n${summary.slice(0, 4000)}` });
    o.history.push(...newer);
  } catch {
    if (!o.ctx.signal.aborted) compact(o.history, budget);
  }
}

/** True when a reply claims the model cannot act, which usually means it is a text-only or vision-only model. */
export function looksToolless(text: string): boolean {
  return /\b(text-based|language model|text-only)\b|(?:can(?:no|')t|unable to|do(?:es)?n't have the ability to|not able to)\s+(?:directly\s+)?(?:open|click|control|access|see|hear|use|interact|launch|type)/i.test(text);
}

/** True when a short reply ends by promising an action ("Let me try again") rather than answering or asking. */
export function announcesAction(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400 || /[?？]\s*$/.test(t)) return false;
  const last = t.split(/(?<=[.!])\s+/).pop() ?? t;
  // "Let me know if…" is a sign-off, not a promise. Treating it as one made the agent nudge a finished task into extra tool calls.
  return /\b(let me(?! know\b)|i(?:'ll| will)|i(?:'m| am) going to|now i(?:'ll| will)?|next,? i(?:'ll| will)?)\b/i.test(last);
}

/**
 * Adds the clock to the request being answered, only in the copy sent to the model. It used to sit at the top of the
 * system prompt, where a new timestamp every run made Ollama re-read the whole system prompt and tool list (seconds per request).
 */
export function withRunTime(history: OMsg[], asked: OMsg | undefined, stamp: string): OMsg[] {
  return history.map((m) => (m === asked ? { ...m, content: `${m.content}\n\n[Current PC local date and time: ${stamp}]` } : m));
}

/** The tool list exactly as it is sent to the model. Start-up priming uses the same function so its prompt matches byte for byte. */
export function toolSpecs(tools: { name: string; description: string; parameters: unknown }[]) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export async function runAgent(o: RunOpts): Promise<'finished' | 'paused' | 'stopped'> {
  const { settings: s, ctx, emit } = o;
  const asked = [...o.history].reverse().find((m) => m.role === 'user');
  const stamp = new Date().toString();
  const specs = toolSpecs(o.tools);

  let lastCallSig = '';
  let nudges = 0;
  let repeatCount = 0;
  for (let step = 0; step < s.maxSteps; step++) {
    if (ctx.signal.aborted) return 'stopped';
    await compactHistory(o, emit);
    if (ctx.signal.aborted) return 'stopped';
    const turnStart = Date.now();
    const latest = o.history.at(-1);
    const directChrome = step === 0 && latest?.role === 'user' && !latest.images?.length && isSimpleChromeLaunch(latest.content) && o.tools.some((tool) => tool.name === 'launch_app');
    const scrollMatch = step === 0 && latest?.role === 'user' && !latest.images?.length && o.tools.some(tool => tool.name === 'desktop_scroll') ? /^Scroll (up|down) in the currently focused application by (10|[1-9]) steps\.$/.exec(latest.content) : null;
    const res = directChrome ? { content: '', toolCalls: [{ function: { name: 'launch_app', arguments: { app: 'Google Chrome' } } }], usage: undefined } : scrollMatch ? { content: '', toolCalls: [{ function: { name: 'desktop_scroll', arguments: { direction: scrollMatch[1], amount: Number(scrollMatch[2]) } } }], usage: undefined } : await streamChat({
      baseUrl: s.baseUrl,
      model: s.model,
      messages: [{ role: 'system', content: o.system }, ...withRunTime(o.history, asked, stamp)],
      tools: specs,
      numCtx: s.numCtx,
      temperature: s.temperature,
      signal: ctx.signal,
      onToken: (text) => emit({ type: 'token', text }),
    });
    emit({ type: 'usage', model: s.model, ms: Date.now() - turnStart, promptTokens: res.usage?.promptTokens, completionTokens: res.usage?.completionTokens, ...(step === 0 ? { sizes: { system: o.system.length, tools: JSON.stringify(specs).length, toolCount: specs.length, history: JSON.stringify(o.history).length } } : {}) });
    for (const tc of res.toolCalls) { if (!tc.id) tc.id = randomUUID(); }
    o.history.push({ role: 'assistant', content: res.content, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
    if (!res.toolCalls.length) {
      if (nudges < 2 && step < s.maxSteps - 1 && announcesAction(res.content)) {
        nudges++;
        o.history.push({ role: 'user', content: nudges === 1
          ? 'You said you would act but made no tool call. Do it now with the right tool. If it cannot be done, say exactly why.'
          : 'Reply with a tool call only, no text. Call the next tool needed for the task right now.' });
        emit({ type: 'note', text: 'The model promised an action without taking it. Asking it to continue…' });
        continue;
      }
      if (step === 0 && o.tools.length && looksToolless(res.content)) emit({ type: 'note', text: `${s.model} answered without using any tools. If Jarvin should act on your PC, pick a tool-capable model such as qwen3.5:4b.` });
      return 'finished';
    }
    nudges = 0; // the model is acting again; give it a fresh nudge budget next time it stalls

    if (res.toolCalls.length > 1) emit({ type: 'note', text: `Running ${res.toolCalls.length} tool calls (reads in parallel; risky actions sequentially).` });

    const callResults: { name: string; output: string; ok: boolean }[] = new Array(res.toolCalls.length);
    // Preserve model call order across writes; only adjacent reads may run together.
    // A read after a write must observe that write, rather than running first.
    const groups: Array<{ read: boolean; actions: Array<() => Promise<void>> }> = [];

    for (let index = 0; index < res.toolCalls.length; index++) {
      const call = res.toolCalls[index];
      const name = call.function.name;
      const args = call.function.arguments;
      const sig = `${name}:${JSON.stringify(args ?? {})}`;
      if (sig === lastCallSig) repeatCount++;
      else {
        lastCallSig = sig;
        repeatCount = 1;
      }
      if (repeatCount >= 3) {
        emit({ type: 'note', text: `Stopped: "${name}" was called 3 times with identical arguments. Try rephrasing or narrowing the task.` });
        return 'paused';
      }
      if (ctx.signal.aborted) {
        const id = randomUUID();
        emit({ type: 'tool_start', id, name, args });
        callResults[index] = { name, output: 'Cancelled by user.', ok: false };
        continue;
      }

      const id = randomUUID();
      emit({ type: 'tool_start', id, name, args });
      const tool = o.tools.find((t) => t.name === name);
      if (!tool) {
        callResults[index] = { name, output: `Unknown tool "${name}". Available: ${o.tools.map((t) => t.name).join(', ')}`, ok: false };
        continue;
      }
      if (o.hooks) {
        let why: string | null = null;
        try { why = await o.hooks.pre(name, args); } catch { /* a broken hook never stops the agent */ }
        if (why) {
          callResults[index] = { name, output: `Blocked by a project hook: ${why}`, ok: false };
          emit({ type: 'tool_result', id, ok: false, output: callResults[index].output });
          continue;
        }
      }
      if (ctx.signal.aborted) return 'stopped';
      const approved = await waitForApproval(o.approve(tool, args, id), ctx.signal);
      if (!approved) {
        callResults[index] = { name, output: 'The user denied this action. Do not retry it; ask what they want instead.', ok: false };
        continue;
      }

      const execute = async () => {
        if (name === 'task_list' && Array.isArray(args?.tasks)) {
          emit({ type: 'tasks', items: args.tasks });
        }
        const live = liveOutput(id, emit);
        const redactPush = (chunk: string) => live.push(redactSecrets(chunk));
        let out = '';
        let ok = true;
        if (ctx.signal.aborted) {
          out = 'Cancelled by user.';
          ok = false;
        } else {
          let endTrack: (() => Promise<number>) | undefined;
          if ((name === 'run_command' || name === 'run_tests') && ctx.trackCommand) {
            try { endTrack = await ctx.trackCommand(); } catch { /* undo for this command is simply unavailable */ }
          }
          try {
            const observe = ['desktop_list_windows', 'desktop_inspect_window', 'see_window', 'inspect_screen', 'list_displays', 'locate_screen_target', 'screen_capture', 'screenshot'].includes(name);
            const control = ['focus_window', 'window_manage', 'desktop_scroll', 'desktop_control', 'click_controls', 'traverse_ui', 'visual_click', 'visual_type', 'click_visual_target', 'mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press', 'save_document'].includes(name);
            if (observe || control) await ctx.desktopActivity?.(observe ? 'observing' : 'controlling');
            if (ctx.signal.aborted) throw new Error('Cancelled by user.');
            out = await tool.run(args, { ...ctx, onOutput: redactPush });
          } catch (e: any) {
            out = `Error: ${e?.message ?? e}`;
            ok = false;
          } finally {
            if (['focus_window', 'window_manage', 'desktop_scroll', 'desktop_control', 'click_controls', 'traverse_ui', 'visual_click', 'visual_type', 'click_visual_target', 'mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press', 'save_document'].includes(name)) ctx.screenInvalidate?.();
            if (['desktop_list_windows', 'focus_window', 'window_manage', 'desktop_scroll', 'desktop_inspect_window', 'see_window', 'inspect_screen', 'list_displays', 'locate_screen_target', 'screen_capture', 'screenshot', 'desktop_control', 'traverse_ui', 'visual_click', 'visual_type', 'click_visual_target', 'mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press', 'save_document'].includes(name)) ctx.desktopActivity?.('off');
          }
          if (endTrack) { try { await endTrack(); } catch { /* ignore */ } }
        }
        live.flush();
        if (o.hooks && !ctx.signal.aborted) {
          try { const extra = await o.hooks.post(name, args, ok); if (extra) out += `\n\n${extra}`; } catch { /* ignore */ }
        }
        out = redactSecrets(out);
        if (out.length > MAX_TOOL_OUT) out = out.slice(0, MAX_TOOL_OUT) + '\n…[truncated]';
        emit({ type: 'tool_result', id, ok, output: out });
        if (tool.risk !== 'read') emit({ type: 'fs_changed' });
        callResults[index] = { name, output: out, ok };
      };

      if (tool.risk === 'read' && groups.at(-1)?.read) groups.at(-1)!.actions.push(execute);
      else groups.push({ read: tool.risk === 'read', actions: [execute] });
    }

    for (const group of groups) {
      if (group.read) await Promise.all(group.actions.map((fn) => fn()));
      else await group.actions[0]();
    }

    if (ctx.signal.aborted) {
      for (let index = 0; index < res.toolCalls.length; index++) {
        const result = callResults[index];
        if (result) o.history.push({ role: 'tool', tool_name: result.name, tool_call_id: res.toolCalls[index]?.id, content: `[Untrusted tool output]\n${result.output}` });
      }
      return 'stopped';
    }
    for (let index = 0; index < res.toolCalls.length; index++) {
      const result = callResults[index];
      if (result) o.history.push({ role: 'tool', tool_name: result.name, tool_call_id: res.toolCalls[index]?.id, content: `[Untrusted tool output]\n${result.output}` });
    }
    if (directChrome) {
      const result = callResults[0];
      const reply = result?.ok ? 'I’ve asked Windows to open Google Chrome.' : result?.output === 'The user denied this action. Do not retry it; ask what they want instead.' ? 'Chrome was not opened because the action was not approved.' : `I couldn’t open Chrome. ${result?.output || 'The launch did not complete.'}`;
      o.history.push({ role: 'assistant', content: reply });
      emit({ type: 'token', text: reply });
      return 'finished';
    }
    if (scrollMatch) {
      const result = callResults[0];
      const denied = result?.output === 'The user denied this action. Do not retry it; ask what they want instead.';
      const reply = result?.ok ? `I sent a scroll ${scrollMatch[1]} to the active window.` : denied ? 'The scroll was not approved.' : `I couldn't scroll the active window. ${result?.output || 'The action did not complete.'}`;
      o.history.push({ role: 'assistant', content: reply });
      emit({ type: 'token', text: reply });
      return 'finished';
    }
  }
  emit({ type: 'note', text: `Paused after ${s.maxSteps} steps. Send a message to continue.` });
  return 'paused';
}
