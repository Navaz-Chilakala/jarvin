import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type DesktopWorker = ((request: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, any>>) & { dispose?: () => void };

/** One fixed worker per task. Requests are serialized and never retried after uncertain input. */
export function persistentDesktopWorker(start: () => ChildProcessWithoutNullStreams, timeoutMs = 20_000): DesktopWorker {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let disposed = false, nextId = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let active: { id: number; finish: (error?: Error, value?: Record<string, any>) => void } | null = null;
  const stop = () => { const old = proc; proc = null; old?.kill(); };
  const fail = (message: string) => { const pending = active; stop(); pending?.finish(new Error(message)); };
  function worker() {
    if (proc) return proc;
    const child = start(); proc = child;
    let buffer = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (proc !== child) return;
      buffer += chunk;
      if (buffer.length > 1_000_000) return fail('Desktop response was too large.');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (!active || message.id !== active.id) return fail('Desktop response did not match the current request.');
          if (typeof message.error === 'string') active.finish(new Error(message.error));
          else if (message.result && typeof message.result === 'object') active.finish(undefined, message.result);
          else return fail('Windows desktop worker returned invalid data.');
        } catch { return fail('Windows desktop worker returned invalid data.'); }
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { if (proc === child) fail(error.message); });
    child.stdin.on('error', error => { if (proc === child) fail(`Desktop connection failed: ${error.message}`); });
    child.on('close', code => { if (proc === child) fail(stderr.trim().slice(0, 1200) || `Desktop worker exited with code ${code}.`); });
    return child;
  }
  const call = ((request: Record<string, unknown>, signal: AbortSignal) => {
    const run = tail.then(() => new Promise<Record<string, any>>((resolve, reject) => {
      if (disposed) return reject(new Error('Desktop task has ended.'));
      if (signal.aborted) return reject(new Error('Cancelled before the desktop operation.'));
      const child = worker(); const id = ++nextId;
      let settled = false;
      const abort = () => fail('Desktop operation cancelled. If input was already sent, look at the window before retrying.');
      const timer = setTimeout(() => fail('Desktop operation timed out. If input was already sent, look at the window before retrying.'), timeoutMs);
      active = { id, finish: (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); active = null;
        error ? reject(error) : resolve(value!);
      } };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      child.stdin.write(JSON.stringify({ id, request }) + '\n');
    }));
    tail = run.catch(() => undefined);
    return run;
  }) as DesktopWorker;
  call.dispose = () => { disposed = true; fail('Desktop task has ended.'); };
  return call;
}
