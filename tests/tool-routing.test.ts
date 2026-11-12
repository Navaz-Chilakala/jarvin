import test from 'node:test';
import assert from 'node:assert/strict';
import { routeToolNames } from '../src/shared/tool-routing';

test('clear screen tasks keep vision, mouse, keyboard, web and document tools without unrelated code agents', () => {
  const names = ['visual_click', 'locate_screen_target', 'click_visual_target', 'keyboard_type', 'inspect_screen', 'chrome_search', 'read_docx', 'write_file', 'run_command', 'git_commit', 'mcp__docs__write'];
  const routed = routeToolNames(names, 'assistant', 'Open Chrome, click the logo, fill the field and write a document');
  assert.deepEqual(routed, names.filter(name => !['run_command', 'git_commit'].includes(name)));
});

test('coding and ambiguous requests retain the full catalogue', () => {
  const names = ['run_command', 'git_commit', 'click_visual_target'];
  assert.deepEqual(routeToolNames(names, 'code', 'Open Chrome'), names);
  assert.deepEqual(routeToolNames(names, 'assistant', 'Open this project and fix a bug'), names);
  assert.deepEqual(routeToolNames(names, 'assistant', 'Help me today'), names);
});

test('desktop requests include window management, scrolling and pointer movement', () => {
  const names = ['window_manage', 'desktop_scroll', 'mouse_move', 'run_command'];
  assert.deepEqual(routeToolNames(names, 'assistant', 'Scroll the window and move the mouse'), names.slice(0, 3));
});

import { isCompanionRequest } from '../src/shared/tool-routing';
test('isCompanionRequest matches plain desktop requests only', () => {
  assert.equal(isCompanionRequest('assistant', 'Open Calculator and calculate 7 × 8'), true);
  assert.equal(isCompanionRequest('assistant', 'open the project and fix the bug in the code'), false);
  assert.equal(isCompanionRequest('code', 'open Calculator'), false);
});

test('plain desktop requests drop file, research, reminder and background tools unless mentioned', () => {
  const names = ['click_controls', 'read_pdf', 'write_file', 'web_search', 'create_reminder', 'background_start', 'mcp__x__y'];
  assert.deepEqual(routeToolNames(names, 'assistant', 'Open Calculator and click 7'), ['click_controls', 'mcp__x__y']);
  assert.deepEqual(routeToolNames(names, 'assistant', 'Open Chrome and search for the weather'), ['click_controls', 'web_search', 'mcp__x__y']);
  assert.ok(routeToolNames(names, 'assistant', 'Open Notepad and remind me in 5 minutes').includes('create_reminder'));
});
