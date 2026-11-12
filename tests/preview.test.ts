import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNavigation, consoleReport, isConsoleNoise, isLocalHost, parsePreviewTarget } from '../src/shared/previewurl';

test('what you type becomes an address or a project file', () => {
  const url = (s: string) => { const r: any = parsePreviewTarget(s); return r.ok ? r.url ?? `file:${r.file}` : `ERR:${r.error}`; };
  assert.equal(url('3000'), 'http://localhost:3000/');
  assert.equal(url('localhost:5173/app'), 'http://localhost:5173/app');
  assert.equal(url('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(url('example.com'), 'https://example.com/');
  assert.equal(url('example.com/a/b.html'), 'https://example.com/a/b.html');
  assert.equal(url('https://example.com/x?y=1'), 'https://example.com/x?y=1');
  assert.equal(url('index.html'), 'file:index.html');
  assert.equal(url('docs/guide.md'), 'file:docs/guide.md');
  assert.equal(url('dist\\index.html'), 'file:dist\\index.html');
  assert.equal(url('C:\\work\\a.html'), 'file:C:\\work\\a.html');
  assert.equal(url('public/logo'), 'file:public/logo');
});

test('anything that is not a web page or a project file is refused', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'chrome://settings', 'ftp://x.com', 'about:blank', 'blob:abc', 'https://u:p@example.com', '', '   ', 'hello', 'a\nb', 'x'.repeat(3000)]) {
    const r: any = parsePreviewTarget(bad);
    assert.equal(r.ok, false, bad);
  }
  assert.equal(parsePreviewTarget(null as any).ok, false);
});

test('navigation inside the preview', () => {
  assert.equal(allowedNavigation('https://example.com/'), true);
  assert.equal(allowedNavigation('http://localhost:3000/x'), true);
  assert.equal(allowedNavigation('javascript:alert(1)'), false);
  assert.equal(allowedNavigation('data:text/html,hi'), false);
  assert.equal(allowedNavigation('chrome://gpu'), false);
  assert.equal(allowedNavigation('https://u:p@example.com/'), false);
  assert.equal(allowedNavigation('file:///c:/proj/index.html'), false, 'no project folder known');
  assert.equal(allowedNavigation('file:///C:/proj/dist/index.html', 'C:\\proj'), true);
  assert.equal(allowedNavigation('file:///C:/projects-other/x.html', 'C:\\proj'), false);
  assert.equal(allowedNavigation('file:///C:/proj/../secret.html', 'C:\\proj'), false);
  assert.equal(allowedNavigation('file:///C:/Windows/win.ini', 'C:\\proj'), false);
  assert.equal(allowedNavigation('about:blank'), true);
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('app.localhost'), true);
  assert.equal(isLocalHost('example.com'), false);
});

test('browser noise is not reported', () => {
  assert.equal(isConsoleNoise('%cElectron Security Warning (Insecure Content-Security-Policy) font-weight:bold;'), true);
  assert.equal(isConsoleNoise('Uncaught TypeError: x'), false);
});

test('console problems become a message for the chat', () => {
  assert.equal(consoleReport('http://x/', []), '');
  const t = consoleReport('http://localhost:3000/', [{ level: 'error', text: 'Uncaught TypeError: x is undefined', source: 'http://localhost:3000/app.js', line: 12 }, { level: 'warning', text: 'deprecated' }]);
  assert.match(t, /2 problems/);
  assert.match(t, /app\.js:12/);
  assert.match(t, /\[warning\] deprecated/);
  const many = consoleReport('u', Array.from({ length: 40 }, (_, i) => ({ level: 'error' as const, text: 'e' + i })));
  assert.match(many, /last 25 shown/);
  assert.ok(many.includes('e39') && !many.includes('e5\n'));
});
