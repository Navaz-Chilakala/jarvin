import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickControl } from '../src/main/windows-uia';

const b = (name: string, role = 'Button', enabled = true) => ({ name, role, enabled });
const calc = [b('One'), b('Zero'), b('Six'), b('Seven'), b('Multiply by'), b('Plus'), b('Equals'), b('Divide by'), b('Decimal separator'), b('Display is 0', 'Text'), b('Clear entry')];

test('pickControl maps digits and symbols to Calculator button names', () => {
  assert.equal(pickControl(calc, '1')?.name, 'One');
  assert.equal(pickControl(calc, '0')?.name, 'Zero');
  assert.equal(pickControl(calc, '×')?.name, 'Multiply by');
  assert.equal(pickControl(calc, '*')?.name, 'Multiply by');
  assert.equal(pickControl(calc, '=')?.name, 'Equals');
  assert.equal(pickControl(calc, '.')?.name, 'Decimal separator');
});

test('pickControl prefers exact names, skips disabled and non-clickable controls', () => {
  assert.equal(pickControl(calc, 'plus')?.name, 'Plus');
  assert.equal(pickControl(calc, 'Display is 0'), undefined);
  assert.equal(pickControl([b('Save', 'Button', false)], 'Save'), undefined);
  assert.equal(pickControl(calc, 'clear')?.name, 'Clear entry');
  assert.equal(pickControl(calc, ''), undefined);
});
