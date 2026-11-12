// What the preview window may open. Pure; the main process adds the file-system checks.

export type PreviewTarget = { ok: true; url: string } | { ok: true; file: string } | { ok: false; error: string };

const FILE_EXT = /\.(html?|xhtml|svg|md|markdown|pdf|png|jpe?g|gif|webp)$/i;

export const isLocalHost = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/** Turns what was typed ("3000", "localhost:5173/app", "example.com", "docs/index.html") into a page address or a workspace file. */
export function parsePreviewTarget(input: unknown): PreviewTarget {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Type an address, a port number, or a file in your project.' };
  let s = input.trim();
  if (s.length > 2000 || /[\u0000-\u001f]/.test(s)) return { ok: false, error: 'That address is not valid.' };
  if (/^\d{2,5}$/.test(s)) s = `http://localhost:${s}`;
  else if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(s)) s = `http://${s}`;
  else if (/^[a-z][a-z0-9+.-]+:/i.test(s) === false) {
    // No scheme. A path to a page in the project, or a web address.
    if (FILE_EXT.test(s.split(/[?#]/)[0]) && !/^[\w-]+(\.[\w-]+)+\//.test(s) ) return { ok: true, file: s };
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s)) s = `https://${s}`;
    else if (/[\\/]/.test(s)) return { ok: true, file: s };
    else return { ok: false, error: 'That does not look like an address. Try localhost:3000 or a file such as index.html.' };
  } else if (/^[a-z]:[\\/]/i.test(s)) {
    return { ok: true, file: s };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'That address is not valid.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `Only http and https pages can be previewed (not ${u.protocol.replace(':', '')}).` };
  if (u.username || u.password) return { ok: false, error: 'Do not put a user name or password in the address.' };
  return { ok: true, url: u.toString() };
}

/** Quick check used for every navigation inside the preview, including redirects and links the page contains. */
export function allowedNavigation(url: string, fileRoot?: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'http:' || u.protocol === 'https:') return !u.username && !u.password;
  if (u.protocol === 'file:' && fileRoot) {
    const p = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\\/g, '/').toLowerCase();
    const r = fileRoot.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    return p === r || p.startsWith(r + '/');
  }
  return u.protocol === 'about:' && url === 'about:blank';
}

export interface ConsoleItem { level: 'error' | 'warning'; text: string; source?: string; line?: number }

/** Messages Electron or the browser add on their own, which are not about the user's page. */
export const isConsoleNoise = (text: string) => /Electron Security Warning|Download the React DevTools|\[vite\] (connecting|connected)/i.test(text);

/** The page's problems as text for the chat box. */
export function consoleReport(url: string, items: ConsoleItem[], max = 25): string {
  if (!items.length) return '';
  const shown = items.slice(-max);
  const lines = shown.map((i) => `- [${i.level}] ${i.text.replace(/\s+/g, ' ').slice(0, 400)}${i.source ? ` (${i.source.split(/[\\/]/).pop()}${i.line ? `:${i.line}` : ''})` : ''}`);
  return `The page at ${url} reported ${items.length} problem${items.length === 1 ? '' : 's'} in the browser console${items.length > max ? ` (last ${max} shown)` : ''}:\n${lines.join('\n')}\n\nFind the cause in the code and fix it.`;
}
