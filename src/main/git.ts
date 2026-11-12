import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { unifiedDiff } from '../shared/udiff';
import { BRANCH_FORMAT, LOG_FORMAT, buildPatch, parseBranches, parseLog, parseStatus, splitDiff, validBranch, validHash, type Branch, type Commit, type GitStatus } from '../shared/gitparse';

export interface RunResult { code: number; out: string; err: string }

const MAX_OUT = 8 * 1024 * 1024;
export const DIFF_CAP = 600_000;

export function runGit(cwd: string, args: string[], o: { input?: string; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_OUT, timeout: o.timeout ?? 30_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' } },
      (err: any, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          const msg = err.code === 'ENOENT' ? 'git was not found. Install Git for Windows and restart Jarvin.' : err.killed ? `git ${args[0]} took too long and was stopped.` : String(err.message ?? err);
          return resolve({ code: 128, out: stdout ?? '', err: msg });
        }
        resolve({ code: err ? err.code : 0, out: stdout ?? '', err: stderr ?? '' });
      },
    );
    if (o.input !== undefined) child.stdin?.end(o.input);
  });
}

/** A path inside the repository, written relative to its top folder. */
export function safeRel(p: unknown): string {
  if (typeof p !== 'string' || !p || p.length > 1000 || p.includes('\0')) throw new Error('Invalid path.');
  const n = p.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) throw new Error('Invalid path.');
  return n;
}

const fail = (r: RunResult, what: string): never => {
  throw new Error((r.err || r.out).trim().split('\n').slice(0, 12).join('\n') || `${what} failed (exit ${r.code}).`);
};

export class GitRepo {
  private constructor(readonly root: string) {}

  /** Finds the repository that contains `dir`; null when there is none. */
  static async open(dir: string): Promise<GitRepo | null> {
    const r = await runGit(dir, ['rev-parse', '--show-toplevel']);
    if (r.code !== 0) return r.err.includes('git was not found') ? fail(r, 'git') : null;
    const top = r.out.trim();
    return top ? new GitRepo(path.resolve(top)) : null;
  }

  static async init(dir: string): Promise<GitRepo> {
    const r = await runGit(dir, ['init']);
    if (r.code !== 0) fail(r, 'git init');
    const repo = await GitRepo.open(dir);
    if (!repo) throw new Error('Could not create the repository.');
    return repo;
  }

  private run = (args: string[], o?: { input?: string; timeout?: number }) => runGit(this.root, args, o);
  private ok = async (args: string[], what: string, o?: { input?: string; timeout?: number }) => {
    const r = await this.run(args, o);
    if (r.code !== 0) fail(r, what);
    return r;
  };

  private hasHead = async () => (await this.run(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;

  async status(): Promise<GitStatus> {
    const r = await this.ok(['status', '--porcelain=v1', '-z', '-b', '-uall'], 'git status');
    return parseStatus(r.out);
  }

  private cap(s: string): string {
    return s.length > DIFF_CAP ? s.slice(0, DIFF_CAP) + `\n… diff cut after ${DIFF_CAP.toLocaleString()} characters\n` : s;
  }

  /** The diff of one file, or of everything, as staged, not staged, or (for a new untracked file) its whole text. */
  async diff(o: { path?: string; kind: 'staged' | 'unstaged' | 'untracked' }): Promise<string> {
    if (o.kind === 'untracked') {
      const rel = safeRel(o.path);
      const file = path.join(this.root, rel);
      const st = fs.statSync(file);
      if (!st.isFile()) return '';
      if (st.size > 1_000_000) return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\0')) return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`;
      return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n${unifiedDiff(null, text.endsWith('\n') ? text.slice(0, -1) : text, rel)}`;
    }
    const args = ['diff', '--no-color', ...(o.kind === 'staged' ? ['--cached'] : [])];
    if (o.path) args.push('--', safeRel(o.path));
    const r = await this.ok(args, 'git diff');
    return this.cap(r.out);
  }

  async stage(paths?: string[]): Promise<void> {
    if (!paths?.length) await this.ok(['add', '-A'], 'git add');
    else await this.ok(['add', '--', ...paths.map(safeRel)], 'git add');
  }

  async unstage(paths?: string[]): Promise<void> {
    const head = await this.hasHead();
    if (!paths?.length) {
      await this.ok(head ? ['reset', '-q', 'HEAD'] : ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '.'], 'unstage');
      return;
    }
    const rel = paths.map(safeRel);
    await this.ok(head ? ['reset', '-q', 'HEAD', '--', ...rel] : ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...rel], 'unstage');
  }

  /** Stage or unstage only some hunks of one file. */
  async hunks(p: string, indexes: number[], mode: 'stage' | 'unstage'): Promise<void> {
    const rel = safeRel(p);
    const diff = await this.ok(['diff', '--no-color', ...(mode === 'unstage' ? ['--cached'] : []), '--', rel], 'git diff');
    const file = splitDiff(diff.out).find((f) => f.path === rel) ?? splitDiff(diff.out)[0];
    if (!file || file.binary) throw new Error('This file cannot be staged piece by piece.');
    const patch = buildPatch(file, indexes);
    if (!patch) throw new Error('Nothing to apply.');
    await this.ok(['apply', '--cached', '--recount', '--whitespace=nowarn', ...(mode === 'unstage' ? ['-R'] : []), '-'], 'git apply', { input: patch });
  }

  /** Throws away not-yet-staged changes to a tracked file. Cannot be undone. */
  async discard(p: string): Promise<void> {
    const rel = safeRel(p);
    const tracked = await this.run(['ls-files', '--error-unmatch', '--', rel]);
    if (tracked.code !== 0) throw new Error('Only changes to files git already tracks can be discarded here.');
    await this.ok(['checkout', '--', rel], 'discard');
  }

  async branches(): Promise<Branch[]> {
    const r = await this.ok(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], 'git branch');
    return parseBranches(r.out);
  }

  async checkout(name: string, remote = false): Promise<string> {
    if (!validBranch(name)) throw new Error('That is not a valid branch name.');
    const r = await this.ok(remote ? ['checkout', '--track', name] : ['checkout', name], 'checkout');
    return (r.err + r.out).trim();
  }

  async createBranch(name: string, from?: string): Promise<string> {
    if (!validBranch(name)) throw new Error('That is not a valid branch name.');
    if (from !== undefined && !validBranch(from)) throw new Error('That is not a valid starting point.');
    const r = await this.ok(['checkout', '-b', name, ...(from ? [from] : [])], 'create branch');
    return (r.err + r.out).trim();
  }

  async deleteBranch(name: string, force: boolean): Promise<string> {
    if (!validBranch(name)) throw new Error('That is not a valid branch name.');
    const cur = (await this.status()).branch;
    if (cur === name) throw new Error('You are on that branch. Switch to another one first.');
    const r = await this.ok(['branch', force ? '-D' : '-d', name], 'delete branch');
    return (r.out + r.err).trim();
  }

  async commit(message: string, amend = false): Promise<string> {
    if (typeof message !== 'string' || !message.trim()) throw new Error('Write a commit message first.');
    if (!amend) {
      const st = await this.status();
      if (!st.files.some((f) => f.staged)) throw new Error('Nothing is staged. Stage some files first.');
    }
    const r = await this.ok(['commit', ...(amend ? ['--amend'] : []), '-F', '-'], 'commit', { input: message.trim() + '\n', timeout: 120_000 });
    return r.out.trim().split('\n')[0] ?? 'Committed.';
  }

  async log(n = 50): Promise<Commit[]> {
    if (!(await this.hasHead())) return [];
    const r = await this.ok(['log', `-n${Math.max(1, Math.min(200, n))}`, `--format=${LOG_FORMAT}`], 'git log');
    return parseLog(r.out);
  }

  async show(hash: string): Promise<string> {
    if (!validHash(hash)) throw new Error('Invalid commit.');
    const r = await this.ok(['show', '--no-color', '--stat', '--patch', '--format=%an  ·  %cr%n%n%B', hash], 'git show');
    return this.cap(r.out);
  }

  async remoteUrl(): Promise<string> {
    const r = await this.run(['remote']);
    const name = r.out.split('\n').map((s) => s.trim()).filter(Boolean).sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0))[0];
    if (!name) return '';
    return (await this.run(['remote', 'get-url', name])).out.trim();
  }

  private async remoteName(): Promise<string> {
    const r = await this.run(['remote']);
    const names = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!names.length) throw new Error('This repository has no remote. Add one with: git remote add origin <url>');
    return names.includes('origin') ? 'origin' : names[0];
  }

  async fetch(): Promise<string> {
    const r = await this.ok(['fetch', '--prune'], 'fetch', { timeout: 120_000 });
    return (r.err + r.out).trim() || 'Fetched.';
  }

  async pull(): Promise<string> {
    const r = await this.ok(['pull', '--ff-only'], 'pull', { timeout: 120_000 });
    return (r.out + r.err).trim() || 'Up to date.';
  }

  async push(): Promise<string> {
    const st = await this.status();
    if (st.detached) throw new Error('You are not on a branch, so there is nothing to push.');
    const args = st.upstream ? ['push'] : ['push', '-u', await this.remoteName(), st.branch];
    const r = await this.ok(args, 'push', { timeout: 120_000 });
    return (r.err + r.out).trim() || 'Pushed.';
  }

  /** The branch a pull request would target: the remote's default, else main, master or develop. */
  async baseBranch(): Promise<string> {
    const sym = await this.run(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
    if (sym.code === 0 && sym.out.trim()) return sym.out.trim();
    for (const c of ['origin/main', 'origin/master', 'main', 'master', 'develop']) {
      if ((await this.run(['rev-parse', '--verify', '-q', c])).code === 0) return c;
    }
    return '';
  }

  async prContext(base: string): Promise<{ head: string; log: string; stat: string; diff: string; commits: number }> {
    if (!validBranch(base)) throw new Error('Pick a base branch first.');
    const st = await this.status();
    const range = `${base}...HEAD`;
    const log = await this.ok(['log', '--no-color', '--format=%s%n%b%n--', `${base}..HEAD`], 'git log');
    const stat = await this.ok(['diff', '--no-color', '--stat', range], 'git diff');
    const diff = await this.ok(['diff', '--no-color', range], 'git diff');
    const commits = Number((await this.ok(['rev-list', '--count', `${base}..HEAD`], 'git rev-list')).out.trim()) || 0;
    return { head: st.branch, log: log.out, stat: stat.out, diff: diff.out, commits };
  }

  async recentSubjects(n = 8): Promise<string[]> {
    if (!(await this.hasHead())) return [];
    return (await this.run(['log', `-n${n}`, '--format=%s'])).out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async stagedContext(): Promise<{ stat: string; diff: string }> {
    const stat = await this.ok(['diff', '--no-color', '--cached', '--stat'], 'git diff');
    const diff = await this.ok(['diff', '--no-color', '--cached'], 'git diff');
    return { stat: stat.out, diff: diff.out };
  }
}
