/** Renderer-safe pieces of the voice MCP server (no Node imports): limits and the client config to copy. */
export const MAX_LISTEN_SEC = 60;
export const MAX_SPEAK_CHARS = 2000;

export function clampListen(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(MAX_LISTEN_SEC, Math.max(2, Math.round(n))) : 15;
}

export function clientConfig(port: number, token: string): string {
  return JSON.stringify({ mcpServers: { 'jarvin-voice': { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}
