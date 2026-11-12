import test from 'node:test';
import assert from 'node:assert/strict';
import { locateVisibleTarget, visualClick, type VisualClickDriver } from '../src/main/visual-action';
import { VisualGrounding, type ScreenFrame } from '../src/main/visual-grounding';

function frame(image: string): ScreenFrame {
  return { image, fingerprint: new Uint8Array(64 * 36 * 4).fill(80), displayId: 'primary', width: 1200, height: 800 };
}

function driver(events: string[], afterImage = 'after'): VisualClickDriver {
  let captures = 0;
  return {
    visual: new VisualGrounding(), signal: new AbortController().signal,
    frame: async (fresh) => { events.push(`frame:${fresh}`); captures++; return frame(captures === 3 ? afterImage : 'before'); },
    pinForeground: async () => { events.push('pin'); return 'window'; },
    checkForeground: async () => { events.push('check'); },
    click: async (_window, x, y) => { events.push(`click:${x},${y}`); return 'sent'; },
    inspect: async (image) => { events.push(`inspect:${image}`); return image === 'before' ? '500,500' : 'The requested result is visible.'; },
    invalidate: () => { events.push('invalidate'); },
    settle: async () => { events.push('settle'); },
  };
}

test('visual click locates, sends one mouse click, then checks a new image', async () => {
  const events: string[] = [];
  const result = JSON.parse(await visualClick('the blue button', 'the success message', driver(events)));
  assert.equal(result.input_sent, true);
  assert.match(result.observation, /requested result/);
  assert.deepEqual(events, ['pin', 'frame:true', 'check', 'inspect:before', 'check', 'frame:true', 'check', 'click:600,400', 'invalidate', 'settle', 'frame:true', 'inspect:after']);
});

test('visual click reports a sent click when later observation fails', async () => {
  const events: string[] = [];
  const d = driver(events);
  d.inspect = async (image) => { if (image === 'before') return '500,500'; throw new Error('Vision unavailable'); };
  const result = JSON.parse(await visualClick('the blue button', '', d));
  assert.equal(result.input_sent, true);
  assert.match(result.observation_error, /Vision unavailable/);
  assert.equal(events.filter(e => e.startsWith('click:')).length, 1);
});

test('visual click does not send input when the screen changed before clicking', async () => {
  const events: string[] = [];
  const d = driver(events);
  let captures = 0;
  d.frame = async () => { captures++; const image = frame('before'); if (captures === 2) image.fingerprint.fill(255); return image; };
  await assert.rejects(visualClick('the blue button', '', d), /target changed/);
  assert.equal(events.some(e => e.startsWith('click:')), false);
});

test('locating a target uses a fresh image and checks focus after vision', async () => {
  const events: string[] = [];
  const d = driver(events);
  const result = JSON.parse(await locateVisibleTarget('the blue button', { ...d, describeWindow: () => 'Chrome — Profile picker' }));
  assert.deepEqual(events, ['pin', 'frame:true', 'check', 'inspect:before', 'check']);
  assert.equal(result.foreground_window, 'Chrome — Profile picker');
  assert.deepEqual(d.visual.consume(result.target_id, frame('before')), { x: 600, y: 400, windowId: 'window' });
});

test('locating a target fails when focus changes during vision', async () => {
  const events: string[] = [];
  const d = driver(events);
  let checks = 0;
  d.checkForeground = async () => { if (++checks === 2) throw new Error('Foreground changed'); };
  await assert.rejects(locateVisibleTarget('the blue button', { ...d, describeWindow: () => 'Chrome' }), /Foreground changed/);
  assert.equal(events.some(e => e.startsWith('click:')), false);
});

test('a visible background window is focused and the target is located again before clicking', async () => {
  const events: string[] = [];
  const d = driver(events);
  let calls = 0;
  d.frame = async () => { calls++; events.push('frame:true'); return frame(calls >= 4 ? 'after' : 'before'); };
  d.focusTargetWindow = async (id, x, y) => { events.push(`focus:${id}:${x},${y}`); return 'other-window'; };
  d.click = async (id, x, y) => { events.push(`click:${id}:${x},${y}`); return 'sent'; };
  const result = JSON.parse(await visualClick('the blue button', 'success', d));
  assert.equal(result.input_sent, true);
  assert.equal(events.filter(e => e === 'inspect:before').length, 2);
  assert.ok(events.includes('focus:window:600,400'));
  assert.ok(events.includes('click:other-window:600,400'));
  assert.ok(events.indexOf('focus:window:600,400') < events.lastIndexOf('inspect:before'));
});

test('a changed image prevents focusing another window', async () => {
  const events: string[] = [];
  const d = driver(events);
  let calls = 0;
  d.frame = async () => { const value = frame('before'); if (++calls === 2) value.fingerprint.fill(255); return value; };
  d.focusTargetWindow = async () => { events.push('focus'); return 'other-window'; };
  await assert.rejects(visualClick('the blue button', '', d), /target changed/);
  assert.equal(events.includes('focus'), false);
  assert.equal(events.some(e => e.startsWith('click:')), false);
});
