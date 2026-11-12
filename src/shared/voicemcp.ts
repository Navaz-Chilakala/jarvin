/** Pure parts of Jarvin's local voice MCP server: request checks, tool list and the client config to copy. */
import crypto from 'node:crypto';
import { MAX_LISTEN_SEC, MAX_SPEAK_CHARS } from './voicemcpcfg';

export interface ReqInfo { method?: string; url?: string; host?: string; origin?: string; auth?: string }
export type Check = { ok: true } | { ok: false; status: number; message: string };

export function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function tokenEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Gate every request. The server only listens on 127.0.0.1, but a web page in the user's browser can still send requests
 * there, so we also require the exact Host, no browser Origin, and the secret token.
 */
export function checkRequest(r: ReqInfo, port: number, token: string): Check {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!r.host || !hosts.includes(r.host.toLowerCase())) return { ok: false, status: 403, message: 'Bad Host header.' };
  if (r.origin) return { ok: false, status: 403, message: 'Browser requests are not allowed.' };
  if (r.url?.split('?')[0] !== '/mcp') return { ok: false, status: 404, message: 'Use /mcp.' };
  if (r.method !== 'POST') return { ok: false, status: 405, message: 'POST only.' };
  const m = /^Bearer\s+(.+)$/i.exec(r.auth ?? '');
  if (!m || !token || !tokenEqual(m[1].trim(), token)) return { ok: false, status: 401, message: 'Missing or wrong token.' };
  return { ok: true };
}


export interface VoiceTool { name: string; description: string; inputSchema: Record<string, unknown> }

export const VOICE_TOOLS: VoiceTool[] = [
  {
    name: 'listen',
    description: `Record from the user's microphone and return what they said as text. Stops when they stop talking or after max_seconds (default 15, up to ${MAX_LISTEN_SEC}). The user sees a "listening" indicator. Needs the user to have allowed agent microphone access in Jarvin.`,
    inputSchema: { type: 'object', properties: { max_seconds: { type: 'number', description: 'Longest recording in seconds.' } } },
  },
  {
    name: 'speak',
    description: `Say text aloud with the user's system voice and wait until it finishes. Up to ${MAX_SPEAK_CHARS} characters.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'transcribe_file',
    description: 'Transcribe an audio or video file inside the user\'s open Jarvin workspace to text, locally. Path is relative to the workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, timestamps: { type: 'boolean', description: 'Prefix each minute with [mm:ss].' } }, required: ['path'] },
  },
];

/** The JSON a user pastes into another agent's MCP settings. */

export { clientConfig, clampListen, MAX_LISTEN_SEC, MAX_SPEAK_CHARS } from './voicemcpcfg';
