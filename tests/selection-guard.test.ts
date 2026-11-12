import test from 'node:test';
import assert from 'node:assert/strict';
import { noteKeyForGuard, overwriteBlocked, resetGuard } from '../src/main/selection-guard';

test('delete, backspace and typing are refused right after Select All', () => {
  resetGuard();
  assert.equal(overwriteBlocked('key', 'Backspace', 1000), '');
  noteKeyForGuard('Ctrl+A', 1000);
  assert.match(overwriteBlocked('key', 'Backspace', 2000), /Blocked/);
  assert.match(overwriteBlocked('key', 'Delete', 2000), /Blocked/);
  assert.match(overwriteBlocked('type', '', 2000), /Blocked/);
  assert.equal(overwriteBlocked('key', 'Ctrl+C', 2000), '');
});

test('the block ends after another key, a reset, or two minutes', () => {
  noteKeyForGuard('Ctrl+A', 1000);
  noteKeyForGuard('Right', 1500);
  assert.equal(overwriteBlocked('key', 'Backspace', 2000), '');
  noteKeyForGuard('Ctrl+A', 1000);
  assert.equal(overwriteBlocked('key', 'Backspace', 1000 + 121_000), '');
  noteKeyForGuard('Ctrl+A', 5000);
  resetGuard();
  assert.equal(overwriteBlocked('type', '', 5001), '');
});
