import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectVerificationCommand, parseVerificationFailures, parseVerificationStats } from '../src/main/verify';

test('detects npm test from package.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-verify-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  const cmd = detectVerificationCommand(root);
  assert.equal(cmd?.framework, 'npm');
  assert.equal(cmd?.command, 'npm test');
});

test('detects pytest from test files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-verify-'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'test_app.py'), 'def test_ok(): pass\n');
  const cmd = detectVerificationCommand(root);
  assert.equal(cmd?.framework, 'pytest');
});

test('parses common verification stats', () => {
  assert.deepEqual(parseVerificationStats('Tests: 2 failed, 8 passed'), { passed: 8, failed: 2, total: 10 });
  assert.deepEqual(parseVerificationStats('test result: FAILED. 3 passed; 1 failed'), { passed: 3, failed: 1, total: 4 });
  assert.deepEqual(parseVerificationStats('5 passed'), { passed: 5, failed: 0, total: 5 });
});

test('extracts common failure locations', () => {
  const failures = parseVerificationFailures('FAIL tests/app.test.ts\nsrc/app.ts:12:5: error\nFAILED tests/test_app.py::test_name');
  const locs = failures.map((f) => f.location);
  assert.ok(locs.includes('tests/app.test.ts'));
  assert.ok(locs.includes('src/app.ts:12'));
  assert.ok(locs.some((l) => l.includes('tests/test_app.py::test_name')));
});