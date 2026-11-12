import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedPoint, VisualGrounding, type ScreenFrame } from '../src/main/visual-grounding';
import { windowsKeySequence } from '../src/main/keyboard';

const frame = (): ScreenFrame => ({ image: 'test', fingerprint: new Uint8Array(100).fill(80), displayId: 'primary', width: 1920, height: 1080 });

test('visual targets use calibrated screen coordinates and can be clicked only once', async () => {
  const vision = new VisualGrounding();
  const result = JSON.parse(await vision.locate(frame(), 'the test button', async () => '500,500'));
  assert.match(vision.describe(result.target_id), /test button/);
  assert.deepEqual(vision.consume(result.target_id, frame()), { x: 960, y: 540 });
  assert.throws(() => vision.consume(result.target_id, frame()), /expired/);
});

test('visual target preserves the window that was observed', async () => {
  const vision = new VisualGrounding();
  const result = JSON.parse(await vision.locate(frame(), 'the test button', async () => '500,500', 'window-ref'));
  assert.deepEqual(vision.consume(result.target_id, frame()), { x: 960, y: 540, windowId: 'window-ref' });
});

test('visual targets refuse changed screens, ambiguous answers and invalid points', async () => {
  const vision = new VisualGrounding();
  const result = JSON.parse(await vision.locate(frame(), 'button', async () => '250,250'));
  const changed = frame(); changed.fingerprint.fill(255);
  assert.throws(() => vision.consume(result.target_id, changed), /target changed/);
  assert.throws(() => vision.consume(result.target_id, frame()), /expired/);
  await assert.rejects(vision.locate(frame(), 'button', async () => 'I cannot see it'), /usable target/);
  assert.equal(normalizedPoint('1001,40'), null);
  assert.equal(normalizedPoint('maybe 40,50?'), null);
});

test('visual target tolerates an unrelated live-screen change but refuses a changed target region', async () => {
  const localFrame = (): ScreenFrame => ({ image: 'test', fingerprint: new Uint8Array(64 * 36 * 4).fill(80), displayId: 'primary', width: 1920, height: 1080 });
  const visual = new VisualGrounding();
  const first = JSON.parse(await visual.locate(localFrame(), 'center button', async () => '500,500'));
  const otherChange = localFrame();
  otherChange.fingerprint.fill(255, 0, 64 * 4);
  assert.deepEqual(visual.consume(first.target_id, otherChange), { x: 960, y: 540 });
  const second = JSON.parse(await visual.locate(localFrame(), 'center button', async () => '500,500'));
  const targetChange = localFrame();
  for (let y = 15; y <= 20; y++) targetChange.fingerprint.fill(255, (y * 64 + 29) * 4, (y * 64 + 36) * 4);
  assert.throws(() => visual.consume(second.target_id, targetChange), /target changed/);
});

test('keyboard shortcuts are selected from fixed sequences', () => {
  assert.equal(windowsKeySequence('Enter'), '{ENTER}');
  assert.equal(windowsKeySequence('Ctrl+L'), '^l');
  assert.throws(() => windowsKeySequence("'; bad command"), /Unsupported/);
});

test('vision coordinates accept a single parenthesized or decimal point but reject ambiguous pairs', () => {
  assert.deepEqual(normalizedPoint('(40, 112)'), { x: 40, y: 112 });
  assert.deepEqual(normalizedPoint('89.3,314.5'), { x: 89.3, y: 314.5 });
  assert.equal(normalizedPoint('40,50\n60,70'), null);
  assert.equal(normalizedPoint('(40,50'), null);
  assert.equal(normalizedPoint('Click at (40,50)'), null);
  assert.equal(normalizedPoint('1000.5,50'), null);
});

test('more shortcuts are allowed, dangerous ones are not', () => {
  assert.equal(windowsKeySequence('Ctrl+Shift+S'), '^+s');
  assert.equal(windowsKeySequence('Alt+Left'), '%{LEFT}');
  assert.equal(windowsKeySequence('F5'), '{F5}');
  assert.throws(() => windowsKeySequence('Alt+F4'), /Unsupported/);
  assert.throws(() => windowsKeySequence('Win+R'), /Unsupported/);
});
