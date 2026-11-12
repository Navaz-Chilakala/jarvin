import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemScript } from '../src/main/system-control';

test('volume and brightness amounts are clamped integers and only whitelisted actions build', () => {
  assert.match(buildSystemScript('volume_up').script, /1\.\.5 /);
  assert.match(buildSystemScript('volume_up', 1000).script, /1\.\.50 /);
  assert.match(buildSystemScript('brightness_set', -5).script, /Brightness=0/);
  assert.match(buildSystemScript('brightness_set', '80; calc').script, /Brightness=50/);
  assert.match(buildSystemScript('dark_mode').script, /AppsUseLightTheme -Value 0/);
  assert.throws(() => buildSystemScript('format_disk'));
  assert.throws(() => buildSystemScript("volume_up'; calc"));
});
