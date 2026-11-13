import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOfficeContent } from '../src/shared/office-content';

test('a table sent with escaped tabs, commas or pipes becomes real rows and columns', () => {
  const escaped = normalizeOfficeContent('.xlsx', 'Item\\tPrice\\nMilk\\t40\\nEggs\\t60');
  assert.equal(escaped.content, 'Item\tPrice\nMilk\t40\nEggs\t60');
  assert.equal(escaped.shape, '3 rows x 2 columns');
  assert.equal(normalizeOfficeContent('.xlsx', 'Item,Price\nMilk,40\nEggs,60').content, 'Item\tPrice\nMilk\t40\nEggs\t60');
  assert.equal(normalizeOfficeContent('.xlsx', '| Item | Price |\n|---|---|\n| Milk | 40 |').content, 'Item\tPrice\nMilk\t40');
  assert.equal(normalizeOfficeContent('.xlsx', 'Item\tPrice, incl. tax\nMilk\t40').shape, '2 rows x 2 columns', 'real tabs win over commas');
  assert.equal(normalizeOfficeContent('.xlsx', 'Just one note').shape, '1 row x 1 column');
});

test('documents and slides report their size and unescape line breaks', () => {
  assert.deepEqual(normalizeOfficeContent('.docx', 'Shopping\\n\\nmilk\\neggs'), { content: 'Shopping\n\nmilk\neggs', shape: '3 lines of text' });
  assert.equal(normalizeOfficeContent('.docx', 'A path C:\\new\\table stays as typed\nsecond line').content, 'A path C:\\new\\table stays as typed\nsecond line');
  assert.equal(normalizeOfficeContent('.pptx', 'Title\nbody\n---\nSecond\nmore').shape, '2 slides');
});

test('PowerPoint content becomes one slide per block, whatever separator the model used', () => {
  // What qwen3:8b really sent: a stray --- first, then blank lines between slides.
  const stray = normalizeOfficeContent('.pptx', '---\nGoa Trip\nThree days in December\n\nBudget\nTotal 25000 rupees\n\nPacking\nSunscreen and Camera');
  assert.equal(stray.shape, '3 slides');
  assert.equal(stray.content, 'Goa Trip\nThree days in December\n---\nBudget\nTotal 25000 rupees\n---\nPacking\nSunscreen and Camera');
  // Proper separators are kept, and a slide may then hold a blank line.
  const proper = normalizeOfficeContent('.pptx', 'Title\nLine\n---\nSecond\n\nMore\n---\n');
  assert.equal(proper.shape, '2 slides');
  assert.equal(proper.content, 'Title\nLine\n---\nSecond\n\nMore');
  assert.equal(normalizeOfficeContent('.pptx', 'Only slide\nOne line').shape, '1 slide');
});
