import fs from 'node:fs';
import path from 'node:path';

type Platform = NodeJS.Platform;

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const SENSITIVE = [
  /(^|\/)\.env(\.|$)/i,
  /^\.jarvin(\/|$)/i,
  /^\.github\/workflows(\/|$)/i,
  /^\.vscode(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)(id_rsa|id_ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12)$/i,
  /(^|\/)\.(npmrc|pypirc|netrc)$/i,
];

/** Checks on the raw path string, before the disk is touched. */
export function checkRawPath(p: string, platform: Platform = process.platform): void {
  if (p.includes('\0')) throw new Error('Path contains a null byte.');
  if (platform !== 'win32') return;
  if (/^[\\/]{2}/.test(p)) throw new Error(`Network and device paths are not allowed: "${p}".`);
  if (p.replace(/^[a-zA-Z]:/, '').includes(':')) throw new Error(`Alternate data streams are not allowed: "${p}".`);
  for (const seg of p.split(/[\\/]/)) {
    if (!seg || seg === '.' || seg === '..') continue;
    if (WIN_RESERVED.test(seg)) throw new Error(`Reserved device name in path: "${seg}".`);
    if (/[. ]$/.test(seg)) throw new Error(`Path segments may not end with a dot or space: "${seg}".`);
  }
}

/** True when `target` is `root` or lies below it. Case-insensitive on Windows and macOS. */
export function isInside(root: string, target: string, platform: Platform = process.platform): boolean {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const fold = (s: string) => (platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s);
  const rel = P.relative(fold(root), fold(target));
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

/** Real path of the deepest existing ancestor, with the missing tail appended. Refuses broken symlinks. */
function realpathDeepest(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e: any) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      let isLink = false;
      try {
        isLink = fs.lstatSync(cur).isSymbolicLink();
      } catch {
        /* does not exist at all */
      }
      if (isLink) throw new Error(`"${path.basename(cur)}" is a broken symlink; refusing to follow it.`);
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export interface ResolveOpts {
  /** The caller will modify the path. Blocks `.git` internals. */
  write?: boolean;
}

/**
 * Resolve a workspace path and refuse anything that leaves the workspace once symlinks,
 * junctions, `..`, drive letters and UNC paths are resolved. Returns the normalised path.
 */
export function resolveSafe(root: string, p: string, opts: ResolveOpts = {}): string {
  if (!root) throw new Error('No workspace folder is open.');
  checkRawPath(p ?? '');
  const rootReal = fs.realpathSync.native(root);
  const abs = path.resolve(rootReal, p || '.');
  const real = realpathDeepest(abs);
  if (!isInside(rootReal, real)) throw new Error(`Path "${p}" is outside the workspace.`);
  if (opts.write) {
    const first = path.relative(rootReal, real).split(path.sep)[0].toLowerCase();
    if (first === '.git') throw new Error('Writing inside .git is blocked.');
  }
  return abs;
}

/** Redact common secret patterns from text before it is shown or logged. */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return text;
  let out = text;
  out = out.replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]');
  out = out.replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]');
  out = out.replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]');
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  out = out.replace(/\b(token|secret|password|api[_-]?key|access[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"'&,}]+)/gi, '$1$2[REDACTED]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]');
  return out;
}

/** Paths whose changes need explicit approval in every mode (secrets, CI, editor and Jarvin config). */
export function isSensitivePath(rel: string): boolean {
  const n = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  return SENSITIVE.some((re) => re.test(n));
}
