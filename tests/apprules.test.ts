import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAppRules, pickAppRule, parseActiveApp, describeApply } from '../src/shared/apprules';

test('rules parse tones and modes, ignore junk and comments', () => {
  const r = parseAppRules('# apps\nSlack, Discord => casual\noutlook,gmail => formal clean\ncode => comment\nx => formal\nfoo => bananas\nnoarrow\n => casual');
  assert.deepEqual(r, [
    { match: ['slack', 'discord'], tone: 'casual' },
    { match: ['outlook', 'gmail'], tone: 'formal', mode: 'clean' },
    { match: ['code'], mode: 'comment' },
  ]);
});

test('first matching rule wins; matches app name or window title, case-insensitive', () => {
  const r = parseAppRules('slack => casual\ngmail => formal\nchrome => concise');
  assert.equal(pickAppRule(r, { app: 'slack', title: 'general' })?.tone, 'casual');
  assert.equal(pickAppRule(r, { app: 'chrome', title: 'Inbox - Gmail - Google Chrome' })?.tone, 'formal', 'title match before the later chrome rule');
  assert.equal(pickAppRule(r, { app: 'Chrome', title: 'News' })?.tone, 'concise');
  assert.equal(pickAppRule(r, { app: 'notepad', title: '' }), null);
  assert.equal(pickAppRule(r, null), null);
  assert.equal(pickAppRule([], { app: 'slack', title: '' }), null);
});

test('active app output parsing', () => {
  assert.deepEqual(parseActiveApp('slack|general - Slack\r\n'), { app: 'slack', title: 'general - Slack' });
  assert.deepEqual(parseActiveApp('WARNING: x\nnotepad|a|b'), { app: 'notepad', title: 'a|b' });
  assert.equal(parseActiveApp(''), null);
  assert.equal(parseActiveApp('|only title'), null);
  assert.equal(describeApply({ match: ['x'], tone: 'casual', mode: 'clean' }, { app: 'slack', title: '' }), 'casual clean for slack');
});
