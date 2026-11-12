const KEYS: Record<string, string> = {
  enter: '{ENTER}', tab: '{TAB}', escape: '{ESC}', backspace: '{BACKSPACE}',
  arrowup: '{UP}', arrowdown: '{DOWN}', arrowleft: '{LEFT}', arrowright: '{RIGHT}',
  delete: '{DELETE}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  'ctrl+l': '^l', 'ctrl+a': '^a', 'ctrl+c': '^c', 'ctrl+v': '^v', 'ctrl+t': '^t', 'ctrl+z': '^z', 'ctrl+f': '^f', 'ctrl+s': '^s',
  'ctrl+shift+s': '^+s', 'ctrl+n': '^n', 'ctrl+o': '^o', 'ctrl+x': '^x', 'ctrl+y': '^y', 'ctrl+w': '^w', 'ctrl+r': '^r', 'ctrl+d': '^d',
  'ctrl+tab': '^{TAB}', 'ctrl+shift+tab': '^+{TAB}', 'ctrl+home': '^{HOME}', 'ctrl+end': '^{END}', f2: '{F2}', f5: '{F5}', f6: '{F6}',
  'alt+left': '%{LEFT}', 'alt+right': '%{RIGHT}',
};

export function windowsKeySequence(key: unknown): string {
  const sequence = typeof key === 'string' ? KEYS[key.trim().toLowerCase()] : undefined;
  if (!sequence) throw new Error('Unsupported key. Use Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp, PageDown, arrow keys, Ctrl+L/A/C/V/T/Z/F/S/X/Y/N/O/W/R/D, Ctrl+Shift+S, Ctrl+Tab, Ctrl+Home/End, F2, F5, F6, or Alt+Left/Right.');
  return sequence;
}
