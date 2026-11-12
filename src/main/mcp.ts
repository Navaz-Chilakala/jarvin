import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpStatus } from '../shared/types';
import type { ToolDef } from './tools';

interface ServerCfg {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface Live {
  client: Client;
  tools: ToolDef[];
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

export class McpManager {
  private live = new Map<string, Live>();
  status: McpStatus[] = [];

  tools(): ToolDef[] {
    return [...this.live.values()].flatMap((l) => l.tools);
  }

  async closeAll() {
    await Promise.allSettled([...this.live.values()].map((l) => l.client.close()));
    this.live.clear();
    this.status = [];
  }

  /** Config format matches Claude Desktop / Cursor: { "mcpServers": { name: { command, args, env } | { url } } } */
  async load(configText: string, cwd: string) {
    await this.closeAll();
    const cfg = JSON.parse(configText || '{}') as { mcpServers?: Record<string, ServerCfg> };
    const entries = Object.entries(cfg.mcpServers ?? {});
    this.status = await Promise.all(
      entries.map(async ([rawName, sc]): Promise<McpStatus> => {
        const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
        try {
          const client = new Client({ name: 'jarvin', version: '0.1.0' });
          if (sc.url) {
            await withTimeout(
              client.connect(new StreamableHTTPClientTransport(new URL(sc.url), { requestInit: { headers: sc.headers } })),
              20000,
              'connect',
            );
          } else if (sc.command) {
            await withTimeout(
              client.connect(new StdioClientTransport({ command: sc.command, args: sc.args ?? [], env: sc.env, cwd: cwd || undefined })),
              30000,
              'connect',
            );
          } else throw new Error('Server needs "command" or "url".');

          const { tools } = await withTimeout(client.listTools(), 15000, 'listTools');
          const defs: ToolDef[] = tools.map((t) => ({
            name: `mcp__${name}__${t.name}`,
            description: `[MCP:${name}] ${t.description ?? t.name}`,
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            risk: 'exec' as const,
            summarize: (a) => `MCP ${name}.${t.name}\n${JSON.stringify(a, null, 2)}`,
            run: async (a) => {
              const r: any = await client.callTool({ name: t.name, arguments: a ?? {} });
              const text = (r.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type} content]`)).join('\n');
              return r.isError ? `ERROR: ${text}` : text || '(no output)';
            },
          }));
          // MCP resources (optional capability)
          try {
            const { resources } = await withTimeout(client.listResources(), 10000, 'listResources');
            if (Array.isArray(resources) && resources.length) {
              defs.push({
                name: `mcp__${name}__resources_list`,
                description: `[MCP:${name}] List available resources`,
                parameters: { type: 'object', properties: {} },
                risk: 'read',
                run: async () => (resources.map((r: any) => `${r.uri} — ${r.name ?? ''} ${r.description ?? ''}`).join('\n') || '(none)'),
              });
              defs.push({
                name: `mcp__${name}__resource_read`,
                description: `[MCP:${name}] Read an MCP resource by URI`,
                parameters: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
                risk: 'read',
                summarize: (a) => `MCP ${name} resource: ${a?.uri}`,
                run: async (a) => {
                  const r: any = await client.readResource({ uri: String(a?.uri) });
                  const contents = r?.contents ?? [];
                  const text = contents.map((c: any) => (typeof c.text === 'string' ? c.text : `[${c.mimeType ?? 'binary'}]`)).join('\n');
                  return text || '(empty resource)';
                },
              });
            }
          } catch { /* server doesn't expose resources */ }
          // MCP prompts (optional capability)
          try {
            const { prompts } = await withTimeout(client.listPrompts(), 10000, 'listPrompts');
            if (Array.isArray(prompts) && prompts.length) {
              defs.push({
                name: `mcp__${name}__prompts_list`,
                description: `[MCP:${name}] List available prompts`,
                parameters: { type: 'object', properties: {} },
                risk: 'read',
                run: async () => (prompts.map((p: any) => `${p.name} — ${p.description ?? ''}`).join('\n') || '(none)'),
              });
              defs.push({
                name: `mcp__${name}__prompt_get`,
                description: `[MCP:${name}] Get a prompt by name with optional arguments`,
                parameters: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
                risk: 'read',
                summarize: (a) => `MCP ${name} prompt: ${a?.name}`,
                run: async (a) => {
                  const r: any = await client.getPrompt({ name: String(a?.name), arguments: a?.arguments ?? {} });
                  const msgs = (r?.messages ?? []).map((m: any) => {
                    const c = m?.content;
                    return `[${m?.role ?? 'user'}] ` + (typeof c === 'string' ? c : (c?.text ?? JSON.stringify(c)));
                  });
                  return msgs.join('\n') || '(empty prompt)';
                },
              });
            }
          } catch { /* server doesn't expose prompts */ }
          this.live.set(name, { client, tools: defs });
          return { name, ok: true, tools: defs.length };
        } catch (e: any) {
          return { name, ok: false, tools: 0, error: String(e?.message ?? e) };
        }
      }),
    );
  }
}
