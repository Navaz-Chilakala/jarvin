import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webUrl } from '../src/shared/weburl';

test('website addresses accept only complete HTTP(S) URLs without credentials', () => {
  assert.equal(webUrl(' https://example.com/docs '), 'https://example.com/docs');
  assert.equal(webUrl('http://example.com'), 'http://example.com/');
  for (const value of ['', 'example.com', 'file:///C:/test', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    assert.throws(() => webUrl(value));
  }
});
