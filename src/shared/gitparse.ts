// Renderer-safe git helpers: parse git's machine-readable output, split diffs into hunks, build prompts, read model replies.

export type FileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict' | 'typechange';

export interface GitFile {
  path: string;
  /** Previous name when renamed or copied. */
  from?: string;
  /** Status letters as git prints them: index column, then work-tree column. */
  x: string;
  y: string;
  staged?: FileState;
  unstaged?: FileState;
  conflict?: boolean;
}

export interface GitStatus {
  branch: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  clean: boolean;
}

const STATE: Record<string, FileState> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };
const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Parses `git status --porcelain=v1 -z -b`. */
export function parseStatus(out: string): GitStatus {
  const parts = out.split('\0');
  const st: GitStatus = { branch: '', detached: false, ahead: 0, behind: 0, files: [], clean: true };
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const h = e.slice(3);
      const m = /^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(h);
      let name = m?.[1] ?? h;
      if (/^No commits yet on /.test(name)) name = name.replace(/^No commits yet on /, '');
      if (/^HEAD \(no branch\)/.test(h)) { st.detached = true; name = 'HEAD'; }
      st.branch = name;
      st.upstream = m?.[2];
      const track = m?.[3] ?? '';
      st.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
      st.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
      continue;
    }
    if (e.length < 4) continue;
    const x = e[0];
    const y = e[1];
    const f: GitFile = { path: e.slice(3), x, y };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') f.from = parts[++i];
    if (x === '?' && y === '?') f.unstaged = 'untracked';
    else if (CONFLICTS.has(x + y)) { f.conflict = true; f.unstaged = 'conflict'; }
    else {
      if (x !== ' ') f.staged = STATE[x];
      if (y !== ' ') f.unstaged = STATE[y];
    }
    st.files.push(f);
  }
  st.clean = st.files.length === 0;
  return st;
}

export interface Branch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  subject?: string;
  date?: string;
}

export const BRANCH_FORMAT = '%(HEAD)\x1f%(refname)\x1f%(upstream:short)\x1f%(subject)\x1f%(committerdate:relative)';

export function parseBranches(out: string): Branch[] {
  const res: Branch[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [head, ref, up, subject, date] = line.split('\x1f');
    if (!ref) continue;
    const remote = ref.startsWith('refs/remotes/');
    if (remote && /\/HEAD$/.test(ref)) continue;
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    res.push({ name, current: head === '*', remote, upstream: up || undefined, subject, date });
  }
  return res.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name));
}

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export const LOG_FORMAT = '%H\x1f%h\x1f%s\x1f%an\x1f%cr';

export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter((l) => l.includes('\x1f'))
    .map((l) => {
      const [hash, short, subject, author, date] = l.split('\x1f');
      return { hash, short, subject, author, date };
    });
}

/** Branch names git accepts, minus anything that could be read as an option or a path trick. */
export function validBranch(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > 200) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (/\.\.|@\{|\/\/|[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  return name !== '@';
}

export const validHash = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{4,64}$/i.test(h);

// ---------- diffs ----------

export interface DiffHunk {
  header: string;
  /** The hunk including its @@ line. */
  text: string;
  add: number;
  del: number;
}

export interface FileDiff {
  path: string;
  /** Everything before the first @@. */
  head: string;
  hunks: DiffHunk[];
  add: number;
  del: number;
  binary: boolean;
}

/** Splits `git diff` output into files and hunks. */
export function splitDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const c of chunks) {
    const lines = c.split('\n');
    const first = lines[0];
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(first);
    let path = m ? m[2] : first.slice(11);
    const plus = lines.find((l) => l.startsWith('+++ '));
    if (plus && !plus.startsWith('+++ /dev/null')) path = plus.slice(4).replace(/^b\//, '');
    else {
      const minus = lines.find((l) => l.startsWith('--- '));
      if (minus && !minus.startsWith('--- /dev/null')) path = minus.slice(4).replace(/^a\//, '');
    }
    const at = lines.findIndex((l) => l.startsWith('@@'));
    const binary = at < 0 && lines.some((l) => /^Binary files |^GIT binary patch/.test(l));
    const headLines = at < 0 ? lines : lines.slice(0, at);
    const hunks: DiffHunk[] = [];
    if (at >= 0) {
      let cur: string[] = [];
      const push = () => {
        if (!cur.length) return;
        while (cur.length && cur[cur.length - 1] === '') cur.pop();
        const body = cur.slice(1);
        hunks.push({ header: cur[0], text: cur.join('\n') + '\n', add: body.filter((l) => l[0] === '+').length, del: body.filter((l) => l[0] === '-').length });
      };
      for (const l of lines.slice(at)) {
        if (l.startsWith('@@')) { push(); cur = [l]; } else cur.push(l);
      }
      push();
    }
    out.push({ path, head: headLines.join('\n') + (headLines.length ? '\n' : ''), hunks, add: hunks.reduce((n, h) => n + h.add, 0), del: hunks.reduce((n, h) => n + h.del, 0), binary });
  }
  return out;
}

/** A patch with only the chosen hunks, ready for `git apply --cached`. */
export function buildPatch(file: FileDiff, chosen: number[]): string {
  const pick = chosen.filter((i) => i >= 0 && i < file.hunks.length).sort((a, b) => a - b);
  if (!pick.length) return '';
  return file.head + pick.map((i) => file.hunks[i].text).join('');
}

// ---------- AI wording ----------

export const COMMIT_SYSTEM =
  'You write git commit messages. Reply with only the message: a subject line of at most 72 characters in the imperative mood ("Add", "Fix", not "Added"), ' +
  'then, if the change is not trivial, a blank line and 1 to 5 short bullet points saying what changed and why. ' +
  'No code fences, no quotation marks around the message, no preamble. Match the style of the recent subjects if they are given.';

export function commitUser(diff: string, stat: string, recent: string[], limit = 12000): string {
  const cut = diff.length > limit;
  return `${recent.length ? `Recent commit subjects (for style):\n${recent.map((s) => `- ${s}`).join('\n')}\n\n` : ''}Files changed:\n${stat.trim()}\n\nDiff${cut ? ` (first ${limit} characters of ${diff.length})` : ''}:\n${diff.slice(0, limit)}`;
}

export const PR_SYSTEM =
  'You write pull request descriptions. Reply in exactly this shape and nothing else:\n' +
  'TITLE: <one line, at most 70 characters, imperative>\n\n' +
  '## Summary\n- 2 to 4 bullets on what this does and why\n\n## Changes\n- the notable changes, grouped by area\n\n## How to test\n- steps, only if you can tell from the diff\n' +
  'Do not invent features, tests or issue numbers that are not in the input. No code fences around the whole reply.';

export function prUser(base: string, head: string, log: string, stat: string, diff: string, limit = 14000): string {
  const cut = diff.length > limit;
  return `Merging ${head} into ${base}.\n\nCommits:\n${log.trim() || '(none)'}\n\nFiles changed:\n${stat.trim()}\n\nDiff${cut ? ` (first ${limit} characters of ${diff.length})` : ''}:\n${diff.slice(0, limit)}`;
}

const stripNoise = (s: string) =>
  s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```[a-z]*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

export function parseCommitMessage(reply: string): { subject: string; body: string } {
  let t = stripNoise(reply).replace(/^(commit message|message)\s*:\s*/i, '');
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  const lines = t.split('\n');
  let subject = (lines.shift() ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\.$/, '');
  if (subject.length > 100) subject = subject.slice(0, 97).trimEnd() + '…';
  const body = lines.join('\n').trim();
  return { subject, body };
}

export function parsePr(reply: string): { title: string; body: string } {
  const t = stripNoise(reply);
  const m = /^\s*(?:#+\s*)?title\s*:\s*(.+)$/im.exec(t);
  if (m) {
    const title = m[1].trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 120);
    const body = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).trim();
    return { title, body };
  }
  const lines = t.split('\n');
  return { title: (lines.shift() ?? '').replace(/^#+\s*/, '').trim().slice(0, 120), body: lines.join('\n').trim() };
}

/** A web page that opens a pull request (or merge request) for this branch. GitHub and GitLab only. */
export function compareUrl(remote: string, base: string, head: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return null;
  const host = m[1].toLowerCase();
  const repo = m[2];
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) return null;
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  if (host === 'github.com') return `https://github.com/${repo}/compare/${enc(base)}...${enc(head)}?expand=1`;
  if (host === 'gitlab.com') return `https://gitlab.com/${repo}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(head)}&merge_request[target_branch]=${encodeURIComponent(base)}`;
  return null;
}
