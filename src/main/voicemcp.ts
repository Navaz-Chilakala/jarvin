import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MAX_SPEAK_CHARS, VOICE_TOOLS, checkRequest, clampListen, newToken } from '../shared/voicemcp';
import { MAX_FILE_MB } from '../shared/transcribe';

export type BridgeKind = 'listen' | 'speak' | 'transcribeFile';

export interface VoiceMcpDeps {
  /** Folder where the token is kept. */
  dataDir: string;
  /** Asks the app window to do something (record, speak, decode) and returns its answer. */
  ask: (kind: BridgeKind, payload: unknown, timeoutMs: number) => Promise<{ text?: string; error?: string }>;
  micAllowed: () => boolean;
  /** Resolve a workspace-relative path to an absolute one, or throw. */
  resolveFile: (rel: string) => string;
  log: (line: string) => void;
}

export interface VoiceMcpInfo { running: boolean; port: number; token: string; error?: string }

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

export class VoiceMcpServer {
  private http: http.Server | null = null;
  private port = 0;
  private error = '';
  private listening = false;
  private mic: Promise<unknown> = Promise.resolve();

  constructor(private d: VoiceMcpDeps) {}

  private tokenFile() {
    return path.join(this.d.dataDir, 'voice-mcp-token.txt');
  }
  token(): string {
    try {
      const t = fs.readFileSync(this.tokenFile(), 'utf8').trim();
      if (t.length >= 20) return t;
    } catch { /* first run */ }
    return this.regenerate();
  }
  regenerate(): string {
    const t = newToken();
    fs.mkdirSync(this.d.dataDir, { recursive: true });
    fs.writeFileSync(this.tokenFile(), t, { mode: 0o600 });
    return t;
  }

  info(): VoiceMcpInfo {
    return { running: this.listening, port: this.port, token: this.token(), error: this.error || undefined };
  }

  async sync(enabled: boolean, port: number): Promise<void> {
    if (!enabled) return this.stop();
    if (this.listening && this.port === port) return;
    await this.stop();
    await new Promise<void>((resolve) => {
      const srv = http.createServer((req, res) => void this.handle(req, res, port));
      srv.on('error', (e: any) => {
        this.error = e?.code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another port.` : String(e?.message ?? e);
        this.listening = false;
        this.http = null;
        resolve();
      });
      srv.listen(port, '127.0.0.1', () => {
        this.http = srv;
        this.port = port;
        this.listening = true;
        this.error = '';
        this.d.log(`voice mcp listening on 127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const srv = this.http;
    this.http = null;
    this.listening = false;
    if (!srv) return Promise.resolve();
    return new Promise((r) => {
      srv.close(() => r());
      srv.closeAllConnections?.();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
    const send = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
    };
    const gate = checkRequest({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin as string | undefined, auth: req.headers.authorization }, port, this.token());
    if (gate.ok !== true) return send(gate.status, gate.message);
    let body: unknown;
    try {
      body = await readJson(req, 1_000_000);
    } catch (e: any) {
      return send(400, String(e?.message ?? 'Bad request'));
    }
    const server = this.makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      this.d.log(`voice mcp error: ${e?.message ?? e}`);
      if (!res.headersSent) send(500, 'Internal error');
    }
  }

  private makeServer(): Server {
    const server = new Server({ name: 'jarvin-voice', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: VOICE_TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const name = r.params.name;
      const a: any = r.params.arguments ?? {};
      this.d.log(`voice mcp tool ${name}`);
      try {
        if (name === 'speak') {
          const text = String(a.text ?? '').slice(0, MAX_SPEAK_CHARS).trim();
          if (!text) return fail('text is required');
          const out = await this.d.ask('speak', { text }, 120_000);
          return out.error ? fail(out.error) : ok('Spoken.');
        }
        if (name === 'listen') {
          if (!this.d.micAllowed()) return fail('Microphone access for agents is off. The user can turn it on in Jarvin: Settings → Voice → "Let agents listen through my microphone".');
          const sec = clampListen(a.max_seconds);
          // One microphone: calls queue up instead of fighting over it.
          const run = this.mic.then(() => this.d.ask('listen', { seconds: sec }, (sec + 90) * 1000));
          this.mic = run.catch(() => undefined);
          const out = await run;
          return out.error ? fail(out.error) : ok(out.text?.trim() ? out.text : '(no speech heard)');
        }
        if (name === 'transcribe_file') {
          const abs = this.d.resolveFile(String(a.path ?? ''));
          const st = fs.statSync(abs);
          if (!st.isFile()) return fail('Not a file.');
          if (st.size > MAX_FILE_MB * 1048576) return fail(`File is larger than ${MAX_FILE_MB} MB. Split it first.`);
          const bytes = fs.readFileSync(abs);
          const out = await this.d.ask('transcribeFile', { name: path.basename(abs), bytes: new Uint8Array(bytes), timestamps: !!a.timestamps }, 30 * 60_000);
          return out.error ? fail(out.error) : ok(out.text?.trim() ? out.text : '(no speech found)');
        }
        return fail(`Unknown tool "${name}".`);
      } catch (e: any) {
        return fail(String(e?.message ?? e));
      }
    });
    return server;
  }
}

function readJson(req: http.IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** Pending requests to the app window, answered through the `voicemcp:reply` IPC. */
export class WindowBridge {
  private pending = new Map<string, (r: { text?: string; error?: string }) => void>();
  constructor(private send: (channel: string, msg: unknown) => boolean) {}
  ask(kind: BridgeKind, payload: unknown, timeoutMs: number): Promise<{ text?: string; error?: string }> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: 'Timed out waiting for the Jarvin window.' }); }, timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      if (!this.send('voicemcp:req', { id, kind, payload })) { clearTimeout(timer); this.pending.delete(id); resolve({ error: 'The Jarvin window is not open.' }); }
    });
  }
  reply(id: string, r: { text?: string; error?: string }) {
    const f = this.pending.get(id);
    if (f) { this.pending.delete(id); f(r ?? {}); }
  }
}
