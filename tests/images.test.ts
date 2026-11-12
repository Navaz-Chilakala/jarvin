import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataUrl, imageMime, isImagePath, workspaceImageRef } from '../src/shared/images';

test('image types', () => {
  assert.equal(imageMime('a/b.PNG'), 'image/png');
  assert.equal(imageMime('x.svg?v=2'), 'image/svg+xml');
  assert.equal(isImagePath('notes.txt'), false);
  assert.equal(isImagePath('photo'), false);
  assert.equal(dataUrl('image/png', Buffer.from([1, 2, 3])), 'data:image/png;base64,AQID');
});

test('only project-relative image paths count', () => {
  assert.equal(workspaceImageRef('docs/shot.png'), 'docs/shot.png');
  assert.equal(workspaceImageRef('./docs\\shot.png'), 'docs/shot.png');
  for (const bad of ['https://x.com/a.png', 'http://x/a.png', '//x/a.png', '/etc/a.png', 'C:\\a.png', 'file:///a.png', 'data:image/png;base64,AA', '../a.png', 'a/../../b.png', 'a//b.png', 'a.txt', '', 'a".png', 'a<b>.png', 'a&b.png'])
    assert.equal(workspaceImageRef(bad), null, bad);
});
