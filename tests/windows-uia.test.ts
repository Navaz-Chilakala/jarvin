import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsAutomation, windowsUiaWorker } from '../src/main/windows-uia';
import { findWindowCapture, isBlackCapture } from '../src/main/window-capture';

test('desktop actions use one-shot references from an inspected window', async () => {
  const calls: any[] = [];
  const desktop = new WindowsAutomation(async (request) => {
    calls.push(request);
    if (request.op === 'list') return { windows: [{ handle: '42', pid: 77, started: '12345', title: 'Test window', app: 'test' }] };
    if (request.op === 'inspect') return { records: [
      { runtime: '1:2', name: 'Search', role: 'Edit', enabled: true, password: false, value: true, invoke: false, x: 1, y: 2, width: 50, height: 20 },
      { runtime: '1:3', name: 'Secret', role: 'Edit', enabled: true, password: true, value: true, invoke: false, x: 1, y: 25, width: 50, height: 20 },
    ], truncated: false };
    return { action: request.action, value_matches: true };
  });
  const signal = new AbortController().signal;
  const listed = JSON.parse(await desktop.list(signal));
  assert.equal(listed.windows[0].title, 'Test window');
  const windowId = listed.windows[0].window_id;
  const inspected = JSON.parse(await desktop.inspect(windowId, signal));
  assert.equal(inspected.controls.length, 1, 'password controls are not exposed');
  assert.match(desktop.describeControl(inspected.snapshot_id, 'c1'), /Search/);
  await assert.rejects(desktop.act(inspected.snapshot_id, 'c1', 'set_value', 'x'.repeat(4001), signal), /4,000/);
  assert.equal(JSON.parse(await desktop.act(inspected.snapshot_id, 'c1', 'set_value', 'hello', signal)).value_matches, true);
  assert.equal(calls.at(-1).runtime, '1:2');
  await assert.rejects(desktop.act(inspected.snapshot_id, 'c1', 'click', '', signal), /expired/);
  await assert.rejects(desktop.inspect('made-up-window', signal), /expired/);
});

test('window image capture checks identity and never selects a different window', async () => {
  const calls: any[] = [];
  const desktop = new WindowsAutomation(async (request) => {
    calls.push(request);
    if (request.op === 'list') return { windows: [{ handle: '42', pid: 77, started: '12345', title: 'Test window', app: 'test' }] };
    return request.op === 'focus' ? { focused: true } : { ok: true };
  });
  const signal = new AbortController().signal;
  const windowId = JSON.parse(await desktop.list(signal)).windows[0].window_id;
  assert.equal(await desktop.captureHandle(windowId, signal), '42');
  assert.deepEqual(calls.at(-1).window, { handle: '42', pid: 77, started: '12345', title: 'Test window', app: 'test' });
  const sources = [{ id: 'window:41:0' }, { id: 'window:42:0' }];
  assert.equal(findWindowCapture(sources, '42'), sources[1]);
  assert.equal(findWindowCapture(sources, '43'), undefined);
  assert.equal(findWindowCapture([...sources, { id: 'window:42:1' }], '42'), undefined);
  assert.equal(JSON.parse(await desktop.focus(windowId, signal)).focused, true);
  assert.equal(isBlackCapture(new Uint8Array([0, 0, 0, 255, 2, 3, 4, 255])), true);
  assert.equal(isBlackCapture(new Uint8Array([0, 0, 25, 255])), false);
  await assert.rejects(desktop.captureHandle('unknown', signal), /expired/);
});

test('desktop worker fails closed off Windows and before a cancelled action', async () => {
  const worker = windowsUiaWorker('unused', 'linux');
  await assert.rejects(worker({ op: 'list' }, new AbortController().signal), /only available on Windows/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(windowsUiaWorker('unused', 'win32')({ op: 'act' }, cancelled.signal), /Cancelled/);
});

test('visual clicks are bound to the identified foreground window', async () => {
  const requests: any[] = [];
  const window = { handle: '42', pid: 77, started: '12345', title: 'Test', app: 'test' };
  const desktop = new WindowsAutomation(async (request) => {
    requests.push(request);
    if (request.op === 'foreground') return { window };
    if (request.op === 'foreground_check') return { ok: true };
    if (request.op === 'click_point') return { action: 'click' };
    throw new Error('unexpected operation');
  });
  const signal = new AbortController().signal;
  const id = await desktop.pinForeground(signal);
  await desktop.checkForeground(id, signal);
  assert.equal(JSON.parse(await desktop.clickPoint(id, 120, 200, signal)).action, 'click');
  assert.deepEqual(requests.at(-1), { op: 'click_point', window, x: 120, y: 200 });
  // Monitors left of or above the primary display have negative origins, so negative coordinates are valid.
  assert.equal(JSON.parse(await desktop.clickPoint(id, -1920, -10, signal)).action, 'click');
  await assert.rejects(desktop.clickPoint(id, 1.5, 0, signal), /Invalid/);
  await assert.rejects(desktop.clickPoint(id, 0, 200_000, signal), /Invalid/);
  await assert.rejects(desktop.clickPoint('unknown', 1, 1, signal), /expired/);
});

test('a target in another visible window is identified and focused before use', async () => {
  const requests: any[] = [];
  const first = { handle: '42', pid: 77, started: '1', title: 'First', app: 'first' };
  const second = { handle: '43', pid: 78, started: '2', title: 'Second', app: 'second' };
  const desktop = new WindowsAutomation(async request => {
    requests.push(request);
    if (request.op === 'foreground') return { window: first };
    if (request.op === 'foreground_check') return { ok: true };
    if (request.op === 'window_at_point') return { window: second };
    if (request.op === 'focus') return { focused: true };
    throw new Error('unexpected operation');
  });
  const signal = new AbortController().signal;
  const oldId = await desktop.pinForeground(signal);
  const newId = await desktop.focusTargetWindow(oldId, 100, 200, signal);
  assert.ok(newId);
  assert.match(desktop.describeWindow(newId), /Second/);
  assert.deepEqual(requests.map(r => r.op), ['foreground', 'foreground_check', 'window_at_point', 'foreground_check', 'focus']);
  assert.deepEqual(requests.at(-1).window, second);
});

test('scroll, cursor movement and window management use the chosen window and validate arguments', async () => {
  const requests: any[] = [];
  const window = { handle: '42', pid: 77, started: '1', title: 'Test', app: 'test' };
  const desktop = new WindowsAutomation(async request => { requests.push(request); return request.op === 'foreground' ? { window } : { sent: true }; });
  const signal = new AbortController().signal;
  const id = await desktop.pinForeground(signal);
  await desktop.scroll(id, 'down', 3, signal);
  assert.deepEqual(requests.at(-1), { op: 'scroll', window, direction: 'down', amount: 3 });
  await desktop.movePointer(id, 25, 30, signal);
  assert.deepEqual(requests.at(-1), { op: 'move_pointer', window, x: 25, y: 30 });
  await desktop.manageWindow(id, 'move', 100, 200, signal);
  assert.deepEqual(requests.at(-1), { op: 'window_manage', window, action: 'move', x: 100, y: 200 });
  await assert.rejects(desktop.scroll(id, 'down', 11, signal), /1–10/);
  await assert.rejects(desktop.manageWindow(id, 'move', 1, undefined, signal), /coordinates/);
  await assert.rejects(desktop.movePointer('missing', 1, 1, signal), /expired/);
});

test('desktop observations fit the agent tool output limit and report truncation', async () => {
  const desktop = new WindowsAutomation(async (request) => request.op === 'list'
    ? { windows: [{ handle: '42', pid: 77, started: '12345', title: 'Test', app: 'test' }] }
    : { records: Array.from({ length: 100 }, (_, i) => ({ runtime: String(i), name: 'x'.repeat(250), role: 'Button', enabled: true, password: false, value: false, x: 1, y: 2, width: 50, height: 20 })) });
  const signal = new AbortController().signal;
  const windowId = JSON.parse(await desktop.list(signal)).windows[0].window_id;
  const raw = await desktop.inspect(windowId, signal);
  const result = JSON.parse(raw);
  assert.equal(result.controls.length, 60);
  assert.equal(result.truncated, true);
  assert.ok(raw.length < 20000);
});

test('a window title or app "Title" string resolves to the single live window with that title', async () => {
  const requests: any[] = [];
  const window = { handle: '42', pid: 77, started: '1', title: 'Calculator', app: 'ApplicationFrameHost' };
  const desktop = new WindowsAutomation(async request => { requests.push(request); return request.op === 'foreground' ? { window } : { sent: true }; });
  const signal = new AbortController().signal;
  await desktop.pinForeground(signal);
  await desktop.manageWindow('ApplicationFrameHost "Calculator"', 'minimize', undefined, undefined, signal);
  assert.equal(requests.at(-1).action, 'minimize');
  assert.deepEqual(requests.at(-1).window, window);
  await desktop.manageWindow('calculator', 'restore', undefined, undefined, signal);
  assert.equal(requests.at(-1).action, 'restore');
  await assert.rejects(desktop.manageWindow('no', 'restore', undefined, undefined, signal), /expired/);
});

test('click_controls leads with what the window shows and clears a calculator before a new sum', async () => {
  const { clickReport, startsWithDigit } = await import('../src/main/windows-uia');
  assert.equal(startsWithDigit(['7', '×', '8', '=']), true);
  assert.equal(startsWithDigit(['OK']), false);
  assert.equal(startsWithDigit([]), false);
  const report = clickReport(['Seven', 'Multiply by', 'Eight', 'Equals'], true, undefined, ['Calculator', 'Expression is 7 × 8=', 'Display is 56']);
  assert.equal(Object.keys(report)[0], 'window_shows');
  assert.equal(report.window_shows, 'Display is 56');
  assert.equal(report.cleared_first, true);
  assert.match(String(report.instruction), /Never state a result that is not in window_shows/);
  const plain = clickReport(['OK'], false, 'Apply', ['Saved']);
  assert.equal('window_shows' in plain, false);
  assert.equal(plain.not_found, 'Apply');
});

test('multi-digit numbers are pressed key by key', async () => {
  const { expandNumberKeys } = await import('../src/main/windows-uia');
  assert.deepEqual(expandNumberKeys(['12', '×', '12', '=']), ['1', '2', '×', '1', '2', '=']);
  assert.deepEqual(expandNumberKeys(['12.5', '+', '7']), ['1', '2', '.', '5', '+', '7']);
  assert.deepEqual(expandNumberKeys(['OK', 'Page 12']), ['OK', 'Page 12']);
});
