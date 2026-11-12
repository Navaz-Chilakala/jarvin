import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenObserver } from '../src/main/screen-observer';
import type { ScreenFrame } from '../src/main/visual-grounding';

test('live screen buffer stays bounded and a click asks for a later frame', async () => {
  let captures = 0;
  const capture = async (): Promise<ScreenFrame> => ({ image: String(++captures), fingerprint: new Uint8Array([captures]), displayId: 'test', width: 100, height: 100 });
  const observer = new ScreenObserver(capture, 10_000);
  const first = await observer.frame();
  assert.equal((await observer.frame()).image, first.image);
  observer.invalidate();
  assert.notEqual((await observer.frame()).image, first.image);
  const afterClick = await observer.frame(true);
  assert.equal(afterClick.image, String(captures));
  assert.notEqual(afterClick.image, first.image);
  observer.stop();
});

test('an in-flight image captured before a window hides is discarded', async () => {
  let resolveFirst!: (frame: ScreenFrame) => void;
  let calls = 0;
  const frame = (image: string): ScreenFrame => ({ image, fingerprint: new Uint8Array([1]), displayId: 'test', width: 100, height: 100 });
  const observer = new ScreenObserver(() => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(frame('after hide')));
  const pending = observer.frame();
  observer.invalidate();
  const current = observer.frame();
  resolveFirst(frame('before hide'));
  assert.equal((await pending).image, 'before hide');
  assert.equal((await current).image, 'after hide');
  observer.stop();
});

test('pausing background vision during speech still allows a fresh frame for a tool', async () => {
  let captures = 0;
  const capture = async (): Promise<ScreenFrame> => ({ image: String(++captures), fingerprint: new Uint8Array([captures]), displayId: 'test', width: 100, height: 100 });
  const observer = new ScreenObserver(capture, 20);
  observer.setPaused(true);
  observer.start();
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(captures, 0);
  assert.equal((await observer.frame(true)).image, '1');
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(captures, 1);
  observer.setPaused(false);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.ok(captures > 1);
  observer.stop();
});
