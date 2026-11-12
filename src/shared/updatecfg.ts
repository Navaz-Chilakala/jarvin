// Renderer-safe update settings and wording.

export type UpdatePhase = 'off' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** Version running now. */
  version: string;
  /** Version found on the server, when there is one. */
  next?: string;
  /** 0..100 while downloading. */
  pct?: number;
  error?: string;
  /** Why checking is switched off, when phase is 'off'. */
  why?: 'dev' | 'nourl' | 'missing';
}

export interface UrlCheck {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Updates replace the program, so the feed must come over HTTPS.
 * Plain http is allowed only for this PC (127.0.0.1, ::1, localhost), for testing a feed you host yourself.
 */
export function validUpdateUrl(raw: unknown): UrlCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'No update address set.' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'That is not a web address.' };
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { ok: false, error: 'Use an https:// address. Updates replace the program, so they must be encrypted.' };
  if (u.username || u.password) return { ok: false, error: 'Do not put a user name or password in the address.' };
  u.hash = '';
  return { ok: true, url: u.toString().replace(/\/+$/, '') };
}

export function updateText(s: UpdateState): string {
  switch (s.phase) {
    case 'off':
      return s.why === 'dev'
        ? `Version ${s.version}. Updates only work in the installed app, not when running from source.`
        : s.why === 'missing'
          ? `Version ${s.version}. The update library is missing. Run npm install in the Jarvin folder, then rebuild.`
          : `Version ${s.version}. Set an update address to check for new versions.`;
    case 'idle':
      return `Version ${s.version}.`;
    case 'checking':
      return `Version ${s.version}. Checking…`;
    case 'current':
      return `Version ${s.version}. You have the latest version.`;
    case 'available':
      return `Version ${s.next} is available (you have ${s.version}).`;
    case 'downloading':
      return `Downloading ${s.next ?? 'the update'}${s.pct !== undefined ? ` ${Math.round(s.pct)}%` : '…'}`;
    case 'ready':
      return `Version ${s.next} is downloaded. Restart Jarvin to finish.`;
    case 'error':
      return `Update problem: ${s.error ?? 'unknown error'}`;
  }
}
