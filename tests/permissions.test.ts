import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCommand, prefixFor, decide, rulesFor, PermissionStore, type FolderRules } from '../src/main/permissions';

const none: FolderRules = { allow: [], deny: [] };
const allowNpmTest: FolderRules = { allow: [{ tool: 'run_command', match: 'npm test' }], deny: [] };
const run = (command: string, rules = none, mode: 'ask' | 'auto-edit' | 'auto' = 'ask') =>
  decide({ tool: 'run_command', risk: 'exec', args: { command }, mode, rules, sensitive: false });

test('parseCommand splits chains and respects quotes', () => {
  assert.deepEqual(parseCommand('npm test && echo "a && b" | cat')?.segments, [['npm', 'test'], ['echo', 'a && b'], ['cat']]);
  assert.deepEqual(parseCommand("git commit -m 'x; y'")?.segments, [['git', 'commit', '-m', 'x; y']]);
});

test('parseCommand refuses anything that can hide a command', () => {
  for (const c of ['echo hi > out.txt', 'cat < f', 'echo $(whoami)', 'echo `id`', 'echo "$(id)"', 'echo ${X}', '(cd x)', 'echo "unclosed'])
    assert.equal(parseCommand(c), null, c);
  assert.deepEqual(parseCommand("echo '$(safe)'")?.segments, [['echo', '$(safe)']]);
});

test('prefixFor keeps sub-commands and refuses risky programs', () => {
  assert.deepEqual(prefixFor(['npm', 'test', '--', '-x']), ['npm', 'test']);
  assert.deepEqual(prefixFor(['git', 'status']), ['git', 'status']);
  assert.equal(prefixFor(['git', '-C', 'x', 'status']), null);
  assert.equal(prefixFor(['npm']), null);
  assert.deepEqual(prefixFor(['Python.exe', 'main.py']), ['python']);
  for (const t of [['rm', '-rf', 'x'], ['powershell', 'x'], ['curl', 'u'], ['node', '-e', '1'], ['python', '-c', '1'], ['./run.sh'], ['C:\\tools\\x.exe']])
    assert.equal(prefixFor(t), null, t.join(' '));
});

test('saved rules allow only matching commands, every segment must match', () => {
  assert.equal(run('npm test', allowNpmTest), 'allow');
  assert.equal(run('npm test -- --watch', allowNpmTest), 'allow');
  assert.equal(run('npm install', allowNpmTest), 'ask');
  assert.equal(run('npm test && rm -rf /', allowNpmTest), 'ask');
  assert.equal(run('npm test; curl evil', allowNpmTest), 'ask');
  assert.equal(run('npm test > x', allowNpmTest), 'ask');
  assert.equal(run('npm testx', allowNpmTest), 'ask');
  assert.equal(run('NPM.cmd TEST', allowNpmTest), 'allow');
});

test('a whole-tool run_command rule never allows anything', () => {
  assert.equal(run('anything', { allow: [{ tool: 'run_command' }], deny: [] }), 'ask');
});

test('deny rules win, even in auto mode and with allow rules', () => {
  const rules: FolderRules = { allow: [{ tool: 'run_command', match: 'git push' }], deny: [{ tool: 'run_command', match: 'git push' }] };
  assert.equal(run('git push', rules, 'auto'), 'deny');
  assert.equal(run('echo hi && git push', rules, 'auto'), 'deny');
});

test('modes: ask, auto-edit, auto', () => {
  const w = (mode: any, sensitive = false) => decide({ tool: 'edit_file', risk: 'write', args: { path: 'a' }, mode, rules: none, sensitive });
  assert.equal(w('ask'), 'ask');
  assert.equal(w('auto-edit'), 'allow');
  assert.equal(w('auto'), 'allow');
  assert.equal(w('auto', true), 'ask');
  assert.equal(w('auto-edit', true), 'ask');
  assert.equal(run('ls', none, 'auto-edit'), 'ask');
  assert.equal(run('ls', none, 'auto'), 'allow');
  assert.equal(decide({ tool: 'read_file', risk: 'read', args: {}, mode: 'ask', rules: none, sensitive: false }), 'allow');
});

test('auto-edit opens common browsers without arguments, while preserving blocks and other approvals', () => {
  const launch = (args: any, mode: any = 'auto-edit', rules = none) => decide({ tool: 'launch_app', risk: 'exec', args, mode, rules, sensitive: false });
  for (const app of ['chrome', 'Google Chrome', 'chrome.exe', 'edge', 'firefox']) assert.equal(launch({ app }), 'allow', app);
  assert.equal(launch({ app: 'Google Chrome', args: [] }), 'allow');
  assert.equal(launch({ app: 'Google Chrome' }, 'ask'), 'ask');
  assert.equal(launch({ app: 'Google Chrome' }, 'plan'), 'deny');
  assert.equal(launch({ app: 'Google Chrome', args: ['--load-extension=unknown'] }), 'ask');
  assert.equal(launch({ app: 'Google Chrome', args: 'invalid' }), 'ask');
  assert.equal(launch({ app: 'C:\\unknown\\chrome.exe' }), 'ask');
  assert.equal(launch({ app: 'unknown.exe' }), 'ask');
  assert.equal(launch({ app: 'chrome' }, 'auto-edit', { allow: [], deny: [{ tool: 'launch_app' }] }), 'deny');
  const website = (url: string, mode: any = 'auto-edit', rules = none) => decide({ tool: 'open_website', risk: 'exec', args: { url }, mode, rules, sensitive: false });
  assert.equal(website('https://example.com/'), 'allow');
  assert.equal(website('http://example.com/'), 'allow');
  assert.equal(website('https://example.com/', 'ask'), 'ask');
  assert.equal(website('https://example.com/', 'plan'), 'deny');
  assert.equal(website('javascript:alert(1)'), 'ask');
  assert.equal(website('https://user:pass@example.com'), 'ask');
  assert.equal(website('https://example.com/', 'auto-edit', { allow: [], deny: [{ tool: 'open_website' }] }), 'deny');
  for (const tool of ['desktop_list_windows', 'focus_window', 'desktop_inspect_window', 'desktop_control', 'see_window', 'inspect_screen', 'locate_screen_target', 'click_visual_target', 'mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press']) {
    assert.equal(decide({ tool, risk: 'exec', args: {}, mode: 'auto-edit', rules: none, sensitive: false }), 'allow', tool);
    assert.equal(decide({ tool, risk: 'exec', args: {}, mode: 'ask', rules: none, sensitive: false }), 'ask', tool);
    assert.equal(decide({ tool, risk: 'exec', args: {}, mode: 'auto-edit', rules: { allow: [], deny: [{ tool }] }, sensitive: false }), 'deny', tool);
  }
  assert.equal(run('ls', none, 'auto-edit'), 'ask');
});

test('screen capture and destructive file actions require fresh approval in every mode', () => {
  for (const [tool, args] of [['screenshot', {}], ['screen_capture', {}], ['delete_file', { path: 'x' }], ['apply_patch', { patch: '*** Begin Patch\n*** Delete File: x\n*** End Patch' }]] as const) {
    assert.equal(decide({ tool, risk: 'exec', args, mode: 'auto', rules: { allow: [{ tool }], deny: [] }, sensitive: false }), 'ask');
    assert.equal(rulesFor(tool, 'exec', args), null);
  }
});

test('sensitive writes ignore saved rules', () => {
  const rules: FolderRules = { allow: [{ tool: 'write_file' }], deny: [] };
  assert.equal(decide({ tool: 'write_file', risk: 'write', args: { path: '.env' }, mode: 'ask', rules, sensitive: true }), 'ask');
  assert.equal(decide({ tool: 'write_file', risk: 'write', args: { path: 'a.ts' }, mode: 'ask', rules, sensitive: false }), 'allow');
});

test('rulesFor builds scoped rules or refuses', () => {
  assert.deepEqual(rulesFor('run_command', 'exec', { command: 'npm test && npm run build' }), [
    { tool: 'run_command', match: 'npm test' },
    { tool: 'run_command', match: 'npm run' },
  ]);
  assert.equal(rulesFor('run_command', 'exec', { command: 'npm test && rm -rf x' }), null);
  assert.equal(rulesFor('run_command', 'exec', { command: 'echo a > b' }), null);
  assert.deepEqual(rulesFor('edit_file', 'write', {}), [{ tool: 'edit_file' }]);
  assert.equal(rulesFor('read_file', 'read', {}), null);
});

test('store persists per folder, de-duplicates and removes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-perm-')), 'p.json');
  const a = new PermissionStore(file);
  a.addAllow('/w/one', [{ tool: 'run_command', match: 'npm test' }]);
  a.addAllow('/w/one', [{ tool: 'run_command', match: 'npm test' }, { tool: 'edit_file' }]);
  const b = new PermissionStore(file);
  assert.equal(b.get('/w/one').allow.length, 2);
  assert.equal(b.get('/w/two').allow.length, 0);
  b.removeAllow('/w/one', 0);
  assert.deepEqual(new PermissionStore(file).get('/w/one').allow, [{ tool: 'edit_file' }]);
});

import { globMatch, relPath, validateRule, workspaceDeny, describeRule } from '../src/main/permissions';

test('globMatch: * stays in a folder, ** crosses folders', () => {
  assert.equal(globMatch('src/**', 'src/a/b.ts'), true);
  assert.equal(globMatch('src/*.ts', 'src/a.ts'), true);
  assert.equal(globMatch('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(globMatch('**/secret*', 'x/y/secret.txt'), true);
  assert.equal(globMatch('**/secret*', 'secret.txt'), true);
  assert.equal(globMatch('docs/?.md', 'docs/a.md'), true);
  assert.equal(globMatch('a.b', 'aXb'), false, 'dots are literal');
  assert.equal(globMatch('SRC/**', 'src/x', true), true);
  assert.equal(globMatch('SRC/**', 'src/x', false), false);
});

test('relPath normalizes and rejects escapes', () => {
  assert.equal(relPath('./src//a.ts'), 'src/a.ts');
  assert.equal(relPath('src\\a.ts'), 'src/a.ts');
  assert.equal(relPath('src/../.env'), '.env');
  assert.equal(relPath('../x'), null);
  assert.equal(relPath('/etc/passwd'), null);
  assert.equal(relPath('C:\\x\\y'), null);
  assert.equal(relPath('/w/proj/src/a.ts', '/w/proj'), 'src/a.ts');
  assert.equal(relPath('', undefined), null);
});

test('path-scoped allow rules only cover matching paths; traversal cannot sneak in', () => {
  const rules: FolderRules = { allow: [{ tool: 'edit_file', path: 'src/**' }], deny: [] };
  const e = (p: any) => decide({ tool: 'edit_file', risk: 'write', args: { path: p }, mode: 'ask', rules, sensitive: false, root: '/w/proj' });
  assert.equal(e('src/a.ts'), 'allow');
  assert.equal(e('/w/proj/src/a.ts'), 'allow');
  assert.equal(e('lib/a.ts'), 'ask');
  assert.equal(e('src/../lib/a.ts'), 'ask');
  assert.equal(e('../src/a.ts'), 'ask');
  assert.equal(e(undefined), 'ask');
});

test('path-scoped block rules apply to reads and writes, even in auto mode', () => {
  const rules: FolderRules = { allow: [], deny: [{ tool: 'read_file', path: 'secrets/**' }, { tool: 'write_file', path: 'dist/**' }] };
  const d = (tool: string, risk: any, p: string) => decide({ tool, risk, args: { path: p }, mode: 'auto', rules, sensitive: false, root: '/w' });
  assert.equal(d('read_file', 'read', 'secrets/key.txt'), 'deny');
  assert.equal(d('read_file', 'read', 'SECRETS/key.txt'), 'deny');
  assert.equal(d('read_file', 'read', 'src/a.ts'), 'allow');
  assert.equal(d('write_file', 'write', 'dist/x.js'), 'deny');
  assert.equal(d('write_file', 'write', './dist/../dist/x.js'), 'deny');
  assert.equal(d('write_file', 'write', 'src/x.js'), 'allow');
});

test('validateRule: allow is filtered like Always-allow, block is permissive, paths must be relative', () => {
  assert.deepEqual(validateRule('allow', { tool: 'run_command', match: 'NPM.cmd test --watch' }), { rule: { tool: 'run_command', match: 'npm test' } });
  for (const m of ['', 'rm -rf x', 'curl x', 'npm', 'npm test && ls', 'echo hi > f', 'node -e 1'])
    assert.ok('error' in validateRule('allow', { tool: 'run_command', match: m }), m);
  assert.deepEqual(validateRule('deny', { tool: 'run_command', match: 'git push --force' }), { rule: { tool: 'run_command', match: 'git push --force' } });
  assert.deepEqual(validateRule('deny', { tool: 'run_command', match: 'rm' }), { rule: { tool: 'run_command', match: 'rm' } });
  assert.ok('error' in validateRule('deny', { tool: 'run_command', match: '' }));
  assert.deepEqual(validateRule('allow', { tool: 'edit_file', path: './src/**' }), { rule: { tool: 'edit_file', path: 'src/**' } });
  assert.deepEqual(validateRule('allow', { tool: 'edit_file' }), { rule: { tool: 'edit_file' } });
  for (const p of ['/etc/*', 'C:\\x', '../x', 'a/../../b']) assert.ok('error' in validateRule('allow', { tool: 'edit_file', path: p }), p);
  assert.ok('error' in validateRule('allow', { tool: 'nope' }, ['edit_file']));
  assert.ok('error' in validateRule('allow', { tool: '' }));
  assert.equal(describeRule({ tool: 'edit_file', path: 'src/**' }), 'edit_file: src/**');
});

test('project block rules load, ignore allow rules and bad entries', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-pw-'));
  assert.deepEqual(workspaceDeny(ws), []);
  fs.mkdirSync(path.join(ws, '.jarvin'));
  fs.writeFileSync(path.join(ws, '.jarvin', 'permissions.json'), JSON.stringify({
    allow: [{ tool: 'run_command', match: 'npm test' }],
    deny: [{ tool: 'run_command', match: 'git push' }, { tool: 'write_file', path: 'dist/**' }, { tool: 'edit_file', path: '/abs' }, 5],
  }));
  assert.deepEqual(workspaceDeny(ws), [{ tool: 'run_command', match: 'git push' }, { tool: 'write_file', path: 'dist/**' }]);
  fs.writeFileSync(path.join(ws, '.jarvin', 'permissions.json'), '{bad');
  assert.deepEqual(workspaceDeny(ws), []);
});

test('store keeps allow and block lists apart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-perm2-')), 'p.json');
  const s = new PermissionStore(file);
  s.addRule('/w/x', 'deny', { tool: 'run_command', match: 'git push' });
  s.addRule('/w/x', 'deny', { tool: 'run_command', match: 'git push' });
  s.addRule('/w/x', 'allow', { tool: 'edit_file', path: 'src/**' });
  s.addRule('/w/x', 'allow', { tool: 'edit_file' });
  const t = new PermissionStore(file).get('/w/x');
  assert.equal(t.deny.length, 1);
  assert.equal(t.allow.length, 2);
  s.removeRule('/w/x', 'deny', 0);
  assert.equal(new PermissionStore(file).get('/w/x').deny.length, 0);
  assert.equal(new PermissionStore(file).get('/w/x').allow.length, 2);
});
