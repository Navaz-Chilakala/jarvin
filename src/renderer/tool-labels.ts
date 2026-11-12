/** Short labels and icons for the tool cards shown in the chat. */
export function describeTool(name: string, a: any): { i: string; v: string; t: string } {
  const p = String(a?.path ?? '');
  switch (name) {
    case 'list_dir': return { i: 'list', v: 'Listed', t: p || '.' };
    case 'read_file': return { i: 'file', v: 'Read', t: p + (a?.start_line ? `:${a.start_line}-${a.end_line ?? ''}` : '') };
    case 'read_pdf': return { i: 'file', v: 'Read PDF', t: p };
    case 'read_docx': return { i: 'file', v: 'Read DOCX', t: p };
    case 'write_file': return { i: 'filePlus', v: 'Write', t: p };
    case 'edit_file': return { i: 'pencil', v: 'Edit', t: p };
    case 'delete_file': return { i: 'x', v: 'Delete', t: p };
    case 'move_file': return { i: 'file', v: 'Move', t: `${a?.from ?? ''} -> ${a?.to ?? ''}` };
    case 'copy_file': return { i: 'copy', v: 'Copy', t: `${a?.from ?? ''} -> ${a?.to ?? ''}` };
    case 'find_files': return { i: 'search', v: 'Find files', t: String(a?.glob ?? '') };
    case 'search_files': return { i: 'search', v: 'Search', t: String(a?.pattern ?? '') };
    case 'git_status': return { i: 'git', v: 'Git status', t: '' };
    case 'git_diff': return { i: 'git', v: 'Git diff', t: String(a?.path ?? a?.staged ? 'staged' : '') };
    case 'git_commit': return { i: 'git', v: 'Git commit', t: String(a?.message ?? '') };
    case 'run_command': return { i: 'terminal', v: 'Run', t: String(a?.command ?? '') };
    case 'web_search': return { i: 'globe', v: 'Web search', t: String(a?.query ?? '') };
    case 'research_web': return { i: 'globe', v: 'Research sources', t: String(a?.query ?? '') };
    case 'chrome_search': return { i: 'globe', v: 'Search in Chrome', t: String(a?.query ?? '') };
    case 'web_fetch': return { i: 'globe', v: 'Fetch', t: String(a?.url ?? '') };
    case 'desktop_list_windows': return { i: 'list', v: 'Find windows', t: '' };
    case 'list_displays': return { i: 'list', v: 'Find displays', t: '' };
    case 'traverse_ui': return { i: 'radio', v: 'Switch ' + String(a?.kind ?? 'view'), t: String(a?.direction ?? '') };
    case 'focus_window': return { i: 'radio', v: 'Open window', t: '' };
    case 'desktop_inspect_window': return { i: 'search', v: 'Inspect window', t: '' };
    case 'see_window': return { i: 'search', v: 'See window', t: '' };
    case 'inspect_screen': return { i: 'search', v: 'See screen', t: '' };
    case 'locate_screen_target': return { i: 'search', v: 'Look at screen', t: String(a?.target ?? '') };
    case 'click_visual_target': return { i: 'radio', v: 'Click visible target', t: '' };
    case 'desktop_control': return { i: 'radio', v: 'Control window', t: String(a?.action ?? '') };
    case 'launch_app': return { i: 'radio', v: 'Open app', t: String(a?.app ?? '') };
    case 'click_controls': return { i: 'radio', v: 'Press buttons', t: Array.isArray(a?.names) ? a.names.join(' ') : '' };
    case 'keyboard_type': return { i: 'radio', v: 'Type', t: String(a?.text ?? '').slice(0, 60) };
    case 'keyboard_press': return { i: 'radio', v: 'Press key', t: String(a?.key ?? '') };
    case 'save_document': return { i: 'file', v: 'Save document', t: String(a?.path ?? '') };
    case 'window_manage': return { i: 'radio', v: 'Arrange window', t: String(a?.action ?? '') };
    case 'system_control': return { i: 'radio', v: 'System setting', t: String(a?.action ?? '') + (a?.amount !== undefined ? ' ' + a.amount : '') };
    case 'find_user_file': return { i: 'search', v: 'Find your file', t: String(a?.query ?? '') };
    case 'open_user_file': return { i: 'file', v: 'Open your file', t: String(a?.path ?? '') };
    case 'get_selected_text': return { i: 'copy', v: 'Read selected text', t: '' };
    case 'visual_click': return { i: 'radio', v: 'Click', t: String(a?.target ?? '') };
    case 'visual_type': return { i: 'radio', v: 'Type in field', t: String(a?.target ?? '') };
    case 'open_website': return { i: 'globe', v: 'Open website', t: String(a?.url ?? '') };
    case 'clipboard_read': return { i: 'copy', v: 'Read clipboard', t: '' };
    case 'clipboard_write': return { i: 'copy', v: 'Copy to clipboard', t: '' };
    default: {
      const [, srv, ...rest] = name.split('__');
      return name.startsWith('mcp__') ? { i: 'plug', v: srv, t: rest.join('__') } : { i: 'code', v: name, t: '' };
    }
  }
}
