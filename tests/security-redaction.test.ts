import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/main/sandbox';
import { redactLogValue } from '../src/main/log-redaction';

test('redactSecrets handles AWS/GitHub/private-key forms', () => {
  const out = redactSecrets('AKIAABCDEFGHIJKLMNOP and ghp_' + 'a'.repeat(20) + ' and -----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----');
  assert.ok(!out.includes('AKIA'));
  assert.ok(!out.includes('ghp_'));
  assert.ok(out.includes('[REDACTED_AWS_KEY]'));
  assert.ok(out.includes('[REDACTED_GITHUB_TOKEN]'));
  assert.ok(out.includes('[REDACTED_PRIVATE_KEY]'));
});

test('structured logs redact nested sensitive fields and recognizable secrets before writing', () => {
  const input = { tool: 'request', args: { password: 'short', auth: { api_key: 'private-value' }, text: 'Bearer abc.123 and sk-' + 'a'.repeat(30) } };
  const output = redactLogValue(input) as any;
  assert.equal(output.tool, 'request');
  assert.equal(output.args.password, '[REDACTED]');
  assert.equal(output.args.auth.api_key, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(output), /private-value|Bearer abc|sk-aaaa/);
  assert.equal(input.args.password, 'short', 'original tool arguments remain unchanged');
});

test('quoted JSON-like secrets are redacted from text', () => {
  const output = redactSecrets('{"password":"small","api_key":"hello"}');
  assert.doesNotMatch(output, /small|hello/);
});

test('redactSecrets redacts key/value and bearer tokens', () => {
  const out = redactSecrets('token: abcdef12345678 and Bearer 123.abc');
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(!out.includes('abcdef12345678'));
  assert.ok(!out.includes('123.abc'));
});
