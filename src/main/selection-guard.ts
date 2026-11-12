/** Stops the agent from wiping a document: after Select All, delete/backspace/typing is refused until the user is asked. */
let selectAllAt = 0;
const WINDOW_MS = 120_000;

export function noteKeyForGuard(key: string, now = Date.now()): void {
  const k = String(key ?? '').replace(/\s+/g, '').toLowerCase();
  if (k === 'ctrl+a') selectAllAt = now;
  else if (!/^(shift|ctrl|alt)$/.test(k)) selectAllAt = 0;
}

/** Returns an error message when this action would overwrite a selected-all document, else ''. */
export function overwriteBlocked(action: 'key' | 'type', key = '', now = Date.now()): string {
  if (!selectAllAt || now - selectAllAt > WINDOW_MS) return '';
  const k = key.replace(/\s+/g, '').toLowerCase();
  if (action === 'key' && !/^(backspace|delete)$/.test(k)) return '';
  return 'Blocked: everything in this window is selected, so this would delete or overwrite the user\'s text. Ask the user first with ask_user. If you want to write new text, open a new document (launch_app with new_document true) instead.';
}

export function resetGuard(): void { selectAllAt = 0; }
