import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDictionary, parseSnippets, applyDictionary, dictionaryTerms, protectSnippets, restoreSnippets } from '../src/shared/lexicon';

test('dictionary parsing: pairs, bare terms, comments, junk', () => {
  const d = parseDictionary('# my words\ncubernetes => Kubernetes\nGitHub\n\n=> nothing\nx =>\n  jarvin  =>  Jarvin  ');
  assert.deepEqual(d, [{ from: 'cubernetes', to: 'Kubernetes' }, { from: 'GitHub', to: 'GitHub' }, { from: 'jarvin', to: 'Jarvin' }]);
});

test('dictionary applies whole words, case-insensitive, keeps $ literal, longest first', () => {
  const d = parseDictionary('cubernetes => Kubernetes\ngithub => GitHub\nnew york city => NYC\nnew york => NY\nprice => $5 & more');
  assert.equal(applyDictionary('deploy to cubernetes and Github', d), 'deploy to Kubernetes and GitHub');
  assert.equal(applyDictionary('i love new york city', d), 'i love NYC');
  assert.equal(applyDictionary('visit new york', d), 'visit NY');
  assert.equal(applyDictionary('the price', d), 'the $5 & more');
  assert.equal(applyDictionary('githubs and mygithub', d), 'githubs and mygithub', 'no partial words');
  assert.equal(applyDictionary('email me@github.com', d), 'email me@github.com', 'no match inside addresses');
  assert.deepEqual(dictionaryTerms(d).slice(0, 2), ['Kubernetes', 'GitHub']);
});

test('snippets parse with \\n line breaks and drop short or empty ones', () => {
  const s = parseSnippets('my email => navaz@example.com\nsign off => Thanks,\\nNavaz\nab => short\nno arrow\nempty trigger =>');
  assert.deepEqual(s, [{ trigger: 'my email', text: 'navaz@example.com' }, { trigger: 'sign off', text: 'Thanks,\nNavaz' }]);
});

test('snippets survive cleanup through placeholders', () => {
  const s = parseSnippets('my email => navaz@example.com\nsign off => Thanks,\\nNavaz');
  const p = protectSnippets('send it to My Email, then sign off.', s);
  assert.ok(!/email/i.test(p.text));
  assert.equal(p.map.length, 2);
  const cleaned = p.text.replace(/^send/, 'Send').toLowerCase().replace(/qqsnip/g, 'QQSNIP').replace(/qq\b/g, 'QQ');
  const back = restoreSnippets(p.text, p.map);
  assert.equal(back, 'send it to navaz@example.com, then Thanks,\nNavaz.');
  assert.ok(restoreSnippets(cleaned.toLowerCase(), p.map) !== undefined);
  assert.equal(restoreSnippets('the model dropped everything', p.map), null);
  assert.equal(restoreSnippets('plain', []), 'plain');
  assert.equal(restoreSnippets('qqsnip0qq and QQSNIP1QQ', p.map), 'navaz@example.com and Thanks,\nNavaz', 'case-insensitive restore');
});
