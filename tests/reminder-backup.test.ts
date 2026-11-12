import test from 'node:test';
import assert from 'node:assert/strict';
import { createScript, cancelScript, popupScript } from '../src/main/reminder-backup';

test('the backup task carries the reminder text only as base64, never as code', () => {
  const text = `Call mom'; Remove-Item C:\\ -Recurse #`;
  const script = createScript({ id: 'abc-123', text, dueAt: 1_800_000_000_000 });
  assert.ok(!script.includes('Remove-Item'));
  assert.ok(!script.includes('Call mom'));
  assert.match(script, /Register-ScheduledTask -TaskName 'JarvinReminder_abc-123'/);
  const popup = popupScript(text);
  const b64 = /FromBase64String\('([^']+)'\)/.exec(popup)![1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), text);
});

test('task names are cleaned and cancel is quiet when missing', () => {
  assert.match(cancelScript("x'; calc; '"), /JarvinReminder_xcalc/);
  assert.match(cancelScript('abc'), /SilentlyContinue/);
  assert.throws(() => createScript({ id: 'a', text: 't', dueAt: NaN }));
});
