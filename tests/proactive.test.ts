import test from 'node:test';
import assert from 'node:assert/strict';
import { PROACTIVE_DEFAULTS, allowSpoken, batteryStep, delivery, inQuietHours, proactiveSettings } from '../src/shared/proactive';

test('proactive notices are opt-in and bad saved times fall back to defaults', () => {
  assert.equal(proactiveSettings(undefined).enabled, false);
  assert.equal(proactiveSettings({ enabled: true, quietFrom: 'late' }).quietFrom, '22:00');
  assert.equal(proactiveSettings({ enabled: true }).enabled, true);
});

test('quiet hours may cross midnight', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 10, h, m);
  assert.equal(inQuietHours(at(23), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at(6, 59), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at(7), '22:00', '07:00'), false);
  assert.equal(inQuietHours(at(13), '12:00', '14:00'), true);
  assert.equal(inQuietHours(at(15), '12:00', '14:00'), false);
  assert.equal(inQuietHours(at(3), '00:00', '00:00'), false, 'equal times mean no quiet hours');
});

test('the battery warning fires once per drop and re-arms on charging', () => {
  let s = batteryStep(false, 0.5, false);
  assert.deepEqual(s, { warn: false, warned: false });
  s = batteryStep(s.warned, 0.2, false);
  assert.deepEqual(s, { warn: true, warned: true });
  assert.equal(batteryStep(s.warned, 0.15, false).warn, false, 'no repeat while still low');
  assert.equal(batteryStep(false, 0.1, true).warn, false, 'never while charging');
  s = batteryStep(true, 0.19, true);
  assert.equal(batteryStep(s.warned, 0.19, false).warn, true, 'unplugging again while low warns again');
});

test('spoken notices are limited per hour and silenced in quiet hours or while Jarvin is talking', () => {
  const now = Date.UTC(2026, 10, 10, 12);
  let history: number[] = [];
  for (let i = 0; i < 4; i++) { const next = allowSpoken(history, now + i * 1000); assert.ok(next); history = next; }
  assert.equal(allowSpoken(history, now + 5000), null);
  assert.ok(allowSpoken(history, now + 3_600_001 + 4000), 'old entries expire');
  const s = { ...PROACTIVE_DEFAULTS, enabled: true };
  assert.equal(delivery(s, new Date(2026, 10, 10, 23), [], false).speak, false);
  assert.equal(delivery(s, new Date(2026, 10, 10, 12), [], true).speak, false);
  assert.equal(delivery(s, new Date(2026, 10, 10, 12), [], false).speak, true);
});
