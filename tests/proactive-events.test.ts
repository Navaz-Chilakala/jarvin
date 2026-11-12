import test from 'node:test';
import assert from 'node:assert/strict';
import type { JarvinApi } from '../src/shared/types';
import { initProactive } from '../src/renderer/proactive';

test('proactive events respect switches, skip failed downloads and announce each meeting once', async () => {
  let progress!: Parameters<JarvinApi['onModelProgress']>[0];
  let finished!: Parameters<JarvinApi['onCommandFinished']>[0];
  let refresh!: () => void;
  const settings = { enabled: false, meetings: true, downloads: true, commands: true, quietFrom: '00:00', quietTo: '00:00' };
  const meeting = { id: '1', state: 'pending', dueAt: Date.now() + 590_000, text: 'Project meeting' };
  const api = {
    onModelProgress(cb: typeof progress) { progress = cb; },
    onCommandFinished(cb: typeof finished) { finished = cb; },
    onReminders(cb: typeof refresh) { refresh = cb; },
    remindersList: async () => [meeting],
  } as unknown as JarvinApi;
  const notices: string[] = [];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const interval = setInterval(() => {}, 30_000);
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: () => interval } });
    initProactive({ jarvin: api, getSettings: () => ({ proactive: settings }) as any, say() {}, toast: t => notices.push(t), isSpeaking: () => false });
    await tick();
    finished('done');
    assert.deepEqual(notices, []);
    settings.enabled = true;
    refresh(); await tick(); refresh(); await tick();
    progress({ name: 'test', status: 'cancelled', done: true, error: 'Cancelled' });
    progress({ name: 'test', status: 'success', done: true });
    finished('failed');
    assert.deepEqual(notices, ['In 10 min: Project meeting', 'Model download finished: test', 'Background command failed. Open Tasks for details.']);
  } finally { clearInterval(interval); Reflect.deleteProperty(globalThis, 'window'); }
});
