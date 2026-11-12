import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BRANCH_FORMAT, buildPatch, compareUrl, parseBranches, parseCommitMessage, parseLog, parsePr, parseStatus, splitDiff, validBranch, validHash, commitUser, prUser } from '../src/shared/gitparse';
import { GitRepo, safeRel } from '../src/main/git';

test('status parsing: branch, tracking, renames, untracked, conflicts, odd names', () => {
  const s = parseStatus('## main...origin/main [ahead 2, behind 1]\0 M src/a.ts\0A  new.ts\0R  b.ts\0a.ts\0?? notes with space.txt\0UU both.ts\0MM two.ts\0');
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.equal(s.files.length, 6);
  const by = (p: string) => s.files.find((f) => f.path === p)!;
  assert.equal(by('src/a.ts').unstaged, 'modified');
  assert.equal(by('src/a.ts').staged, undefined);
  assert.equal(by('new.ts').staged, 'added');
  assert.equal(by('b.ts').staged, 'renamed');
  assert.equal(by('b.ts').from, 'a.ts');
  assert.equal(by('notes with space.txt').unstaged, 'untracked');
  assert.equal(by('both.ts').conflict, true);
  assert.equal(by('two.ts').staged, 'modified');
  assert.equal(by('two.ts').unstaged, 'modified');
  assert.equal(parseStatus('## No commits yet on main\0').branch, 'main');
  assert.equal(parseStatus('## HEAD (no branch)\0').detached, true);
  assert.equal(parseStatus('## main\0').clean, true);
});

test('branch and log parsing', () => {
  const b = parseBranches(['*\x1frefs/heads/main\x1forigin/main\x1fInit\x1f2 days ago', ' \x1frefs/heads/feat/x\x1f\x1fWork\x1f1 hour ago', ' \x1frefs/remotes/origin/main\x1f\x1fInit\x1f2 days ago', ' \x1frefs/remotes/origin/HEAD\x1f\x1f\x1f'].join('\n'));
  assert.deepEqual(b.map((x) => `${x.name}:${x.current}:${x.remote}`), ['main:true:false', 'feat/x:false:false', 'origin/main:false:true']);
  assert.equal(BRANCH_FORMAT.includes('%(refname)'), true);
  const l = parseLog('abc\x1fab\x1fFix thing\x1fAnn\x1f3 days ago\nnoise line');
  assert.equal(l.length, 1);
  assert.equal(l[0].subject, 'Fix thing');
});

test('names and hashes are checked', () => {
  for (const ok of ['main', 'feature/login-fix', 'release-1.2', 'user/jo_x']) assert.equal(validBranch(ok), true, ok);
  for (const bad of ['', '-D', '--force', 'a b', 'a..b', 'a@{1}', 'x/', '/x', 'x.lock', 'a~1', 'a^', 'a:b', 'a\\b', 'a*', '@', null]) assert.equal(validBranch(bad as any), false, String(bad));
  assert.equal(validHash('abc1234'), true);
  assert.equal(validHash('--output=/x'), false);
  assert.equal(validHash('zzzz'), false);
  assert.throws(() => safeRel('../x'), /Invalid/);
  assert.throws(() => safeRel('/etc/passwd'), /Invalid/);
  assert.throws(() => safeRel('C:\\x'), /Invalid/);
  assert.equal(safeRel('src\\a.ts'), 'src/a.ts');
});

const DIFF = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,3 +10,4 @@
 ten
 eleven
+eleven and a half
 twelve
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

test('a diff splits into files and hunks, and a patch can carry just some hunks', () => {
  const f = splitDiff(DIFF);
  assert.equal(f.length, 2);
  assert.equal(f[0].path, 'a.txt');
  assert.equal(f[0].hunks.length, 2);
  assert.deepEqual([f[0].add, f[0].del], [2, 1]);
  assert.equal(f[1].binary, true);
  const p = buildPatch(f[0], [1]);
  assert.ok(p.startsWith('diff --git a/a.txt'));
  assert.ok(p.includes('eleven and a half'));
  assert.ok(!p.includes('TWO'));
  assert.equal(buildPatch(f[0], [5]), '');
});

test('model replies are cleaned up', () => {
  assert.deepEqual(parseCommitMessage('<think>hm</think>\n```\nFix login redirect.\n\n- keep the return url\n```'), { subject: 'Fix login redirect', body: '- keep the return url' });
  assert.equal(parseCommitMessage('Commit message: "Add tests"').subject, 'Add tests');
  assert.ok(parseCommitMessage('x'.repeat(300)).subject.length <= 100);
  const pr = parsePr('TITLE: Add dark mode\n\n## Summary\n- one\n## Changes\n- two');
  assert.equal(pr.title, 'Add dark mode');
  assert.ok(pr.body.startsWith('## Summary'));
  assert.equal(parsePr('# Just a title\nbody').title, 'Just a title');
  assert.match(commitUser('d'.repeat(20000), ' a | 1 +', ['Add x']), /first 12000 characters of 20000/);
  assert.match(prUser('main', 'feat', 'one', 'stat', 'diff'), /Merging feat into main/);
});

test('compare page links for GitHub and GitLab only', () => {
  assert.equal(compareUrl('https://github.com/me/app.git', 'main', 'feat/x'), 'https://github.com/me/app/compare/main...feat/x?expand=1');
  assert.equal(compareUrl('git@github.com:me/app.git', 'main', 'f'), 'https://github.com/me/app/compare/main...f?expand=1');
  assert.match(compareUrl('https://gitlab.com/g/s/app.git', 'main', 'f')!, /^https:\/\/gitlab\.com\/g\/s\/app\/-\/merge_requests\/new\?/);
  assert.equal(compareUrl('https://example.com/me/app.git', 'main', 'f'), null);
  assert.equal(compareUrl('', 'main', 'f'), null);
  assert.equal(compareUrl('https://github.com/me/app', 'main', 'a b#c'), 'https://github.com/me/app/compare/main...a%20b%23c?expand=1');
});

// ---- real repositories ----
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jgit-'));
async function fresh() {
  const d = tmp();
  sh(d, 'init', '-q', '-b', 'main');
  sh(d, 'config', 'user.email', 't@example.com');
  sh(d, 'config', 'user.name', 'Tester');
  sh(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(d, 'a.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'Initial commit');
  const repo = (await GitRepo.open(d))!;
  return { d, repo };
}

test('not a repository, then init', async () => {
  const d = tmp();
  assert.equal(await GitRepo.open(d), null);
  const r = await GitRepo.init(d);
  assert.equal((await r.status()).clean, true);
  assert.deepEqual(await r.log(), []);
});

test('status, diffs, staging whole files, and committing', async () => {
  const { d, repo } = await fresh();
  fs.writeFileSync(path.join(d, 'a.txt'), fs.readFileSync(path.join(d, 'a.txt'), 'utf8').replace('line 2\n', 'LINE TWO\n'));
  fs.writeFileSync(path.join(d, 'new file.txt'), 'hello\nworld\n');
  let st = await repo.status();
  assert.deepEqual(st.files.map((f) => `${f.path}:${f.unstaged}`).sort(), ['a.txt:modified', 'new file.txt:untracked']);
  assert.match(await repo.diff({ path: 'a.txt', kind: 'unstaged' }), /\+LINE TWO/);
  const nd = await repo.diff({ path: 'new file.txt', kind: 'untracked' });
  assert.match(nd, /new file mode/);
  assert.equal(splitDiff(nd)[0].path, 'new file.txt');
  assert.equal(splitDiff(nd)[0].add, 2);
  await assert.rejects(repo.commit('x'), /Nothing is staged/);
  await repo.stage(['a.txt']);
  st = await repo.status();
  assert.equal(st.files.find((f) => f.path === 'a.txt')!.staged, 'modified');
  assert.match(await repo.diff({ path: 'a.txt', kind: 'staged' }), /\+LINE TWO/);
  await repo.unstage(['a.txt']);
  assert.equal((await repo.status()).files.find((f) => f.path === 'a.txt')!.staged, undefined);
  await repo.stage();
  await assert.rejects(repo.commit('   '), /message/);
  await repo.commit('Change line two\n\n- and add a file');
  assert.equal((await repo.status()).clean, true);
  const log = await repo.log();
  assert.equal(log[0].subject, 'Change line two');
  assert.match(await repo.show(log[0].hash), /LINE TWO/);
  await assert.rejects(repo.show('--output=/tmp/x'), /Invalid/);
});

test('staging and unstaging single hunks', async () => {
  const { d, repo } = await fresh();
  const lines = fs.readFileSync(path.join(d, 'a.txt'), 'utf8').split('\n');
  lines[1] = 'EARLY';
  lines[27] = 'LATE';
  fs.writeFileSync(path.join(d, 'a.txt'), lines.join('\n'));
  const parts = splitDiff(await repo.diff({ path: 'a.txt', kind: 'unstaged' }))[0];
  assert.equal(parts.hunks.length, 2);
  await repo.hunks('a.txt', [1], 'stage');
  const staged = await repo.diff({ path: 'a.txt', kind: 'staged' });
  assert.match(staged, /\+LATE/);
  assert.ok(!staged.includes('EARLY'));
  const rest = await repo.diff({ path: 'a.txt', kind: 'unstaged' });
  assert.match(rest, /\+EARLY/);
  assert.ok(!rest.includes('+LATE'));
  await repo.hunks('a.txt', [0], 'unstage');
  assert.equal((await repo.diff({ path: 'a.txt', kind: 'staged' })).trim(), '');
});

test('discard only touches tracked files', async () => {
  const { d, repo } = await fresh();
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(d, 'u.txt'), 'keep me\n');
  await repo.discard('a.txt');
  assert.match(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), /^line 1/);
  await assert.rejects(repo.discard('u.txt'), /already tracks/);
  assert.equal(fs.readFileSync(path.join(d, 'u.txt'), 'utf8'), 'keep me\n');
  await assert.rejects(repo.discard('../x'), /Invalid/);
});

test('branches: create, list, switch, refuse bad names, delete', async () => {
  const { repo } = await fresh();
  await repo.createBranch('feature/x');
  let b = await repo.branches();
  assert.deepEqual(b.map((x) => `${x.name}${x.current ? '*' : ''}`), ['feature/x*', 'main']);
  await assert.rejects(repo.createBranch('--force'), /valid branch/);
  await assert.rejects(repo.checkout('a b'), /valid branch/);
  await repo.checkout('main');
  await assert.rejects(repo.deleteBranch('main', false), /on that branch/);
  await repo.deleteBranch('feature/x', false);
  b = await repo.branches();
  assert.equal(b.length, 1);
  await assert.rejects(repo.checkout('nope'), /nope|did not match/i);
});

test('push, pull, fetch against a local remote; pull request context', async () => {
  const { d, repo } = await fresh();
  const bare = tmp();
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  sh(d, 'remote', 'add', 'origin', bare);
  assert.match(await repo.push(), /main/);
  let st = await repo.status();
  assert.equal(st.upstream, 'origin/main');
  await repo.createBranch('feat');
  fs.writeFileSync(path.join(d, 'f.txt'), 'feature\n');
  await repo.stage();
  await repo.commit('Add f');
  assert.equal((await repo.status()).ahead, 0 + 0, 'no upstream yet, so nothing is counted');
  await repo.push();
  assert.equal((await repo.status()).upstream, 'origin/feat');
  assert.equal(await repo.baseBranch(), 'origin/main');
  const ctx = await repo.prContext('origin/main');
  assert.equal(ctx.commits, 1);
  assert.equal(ctx.head, 'feat');
  assert.match(ctx.stat, /f\.txt/);
  assert.match(ctx.diff, /\+feature/);
  assert.equal(await repo.remoteUrl(), bare);
  await repo.fetch();
  const other = tmp();
  sh(other, 'clone', '-q', bare, '.');
  sh(other, 'config', 'user.email', 't@example.com');
  sh(other, 'config', 'user.name', 'T');
  sh(other, 'checkout', '-q', 'feat');
  fs.writeFileSync(path.join(other, 'g.txt'), 'g\n');
  sh(other, 'add', '-A');
  sh(other, 'commit', '-q', '-m', 'Add g');
  sh(other, 'push', '-q');
  await repo.fetch();
  st = await repo.status();
  assert.equal(st.behind, 1);
  await repo.pull();
  assert.ok(fs.existsSync(path.join(d, 'g.txt')));
  await assert.rejects(repo.prContext('--evil'), /base branch/);
});

test('amend, and a repository with no remote says so', async () => {
  const { d, repo } = await fresh();
  fs.writeFileSync(path.join(d, 'b.txt'), 'b\n');
  await repo.stage();
  await repo.commit('Add b, reworded', true);
  const log = await repo.log();
  assert.equal(log.length, 1);
  assert.equal(log[0].subject, 'Add b, reworded');
  await assert.rejects(repo.push(), /no remote/);
});

test('working from a sub-folder still finds the repository root', async () => {
  const { d } = await fresh();
  fs.mkdirSync(path.join(d, 'pkg'));
  const r = await GitRepo.open(path.join(d, 'pkg'));
  assert.equal(fs.realpathSync(r!.root), fs.realpathSync(d));
});
