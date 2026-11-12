/** Route only clear visual desktop requests; mixed or coding requests retain all tools. */
const DESKTOP_WORDS = /\b(?:screen|display|monitor|tab|window|desktop|volume|brightness|mute|dark mode|light mode|lock|snap|side by side|clipboard|copied|selected|selection|error|mouse|keyboard|click|type|open|launch|website|chrome|browser|navigate|scroll|logo|button|field|fill|paragraph)\b/i;
const MIXED_WORDS = /\b(?:code|debug|project|repository|git|refactor|terminal|command|build|script|program|develop|implement|fix bug|npm|python|typescript)\b/i;
/** Tools every plain desktop request needs. */
const CORE_TOOLS = new Set([
  'open_website', 'chrome_search', 'launch_app', 'desktop_list_windows', 'focus_window', 'window_manage', 'desktop_scroll', 'mouse_move',
  'traverse_ui', 'list_displays', 'visual_click', 'visual_type', 'locate_screen_target', 'click_visual_target', 'see_window', 'inspect_screen',
  'keyboard_press', 'keyboard_type', 'click_controls', 'save_document', 'open_path', 'find_user_file', 'open_user_file', 'system_control', 'get_selected_text', 'reveal_in_explorer', 'clipboard_read', 'clipboard_write',
]);
/** Extra tool groups, added only when the request mentions them, so the prompt the small model reads stays short. */
const OPTIONAL_GROUPS: { words: RegExp; tools: string[] }[] = [
  { words: /\b(?:search|research|look ?up|find out|weather|news|price|web|online|google)\b/i, tools: ['web_search', 'web_fetch', 'research_web'] },
  { words: /\b(?:ocr|scan|scanned|pdf|docx?|word|csv|xlsx?|excel|pptx?|powerpoint|file|files|folder|read|write|save|edit|document)\b/i, tools: ['create_document', 'edit_document', 'ocr_document', 'read_pdf', 'read_docx', 'read_csv', 'read_xlsx', 'read_pptx', 'read_file', 'write_file', 'edit_file', 'list_dir', 'find_files', 'search_files'] },
  { words: /\b(?:routine|setup|set up|workflow|every morning)\b/i, tools: ['routine'] },
  { words: /\b(?:remind|reminder|notify|alarm|timer)\b/i, tools: ['create_reminder', 'notify', 'task_list'] },
  { words: /\b(?:background|long[- ]running|in the background)\b/i, tools: ['background_start', 'background_output', 'background_list', 'background_stop'] },
  { words: /\b(?:skill|skills|convert|converter)\b/i, tools: ['list_converters', 'list_skills', 'read_skill'] },
];

/** True for a plain desktop request on the assistant surface: only the companion tools (and a shorter prompt) are needed. */
export function isCompanionRequest(surface: 'assistant' | 'code', request: string): boolean {
  return surface === 'assistant' && DESKTOP_WORDS.test(request) && !MIXED_WORDS.test(request);
}

export function routeToolNames(names: string[], surface: 'assistant' | 'code', request: string): string[] {
  if (!isCompanionRequest(surface, request)) return names;
  const allowed = new Set(CORE_TOOLS);
  for (const g of OPTIONAL_GROUPS) if (g.words.test(request)) g.tools.forEach(t => allowed.add(t));
  return names.filter(name => allowed.has(name) || name.startsWith('mcp__'));
}
