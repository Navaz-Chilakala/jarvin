/** Pure helpers for editor AI: prompt building and cleaning model output. Kept free of Electron/Monaco so they can be tested. */

export function stripFences(s: string): string {
  let t = String(s ?? '').replace(/\r\n/g, '\n');
  // Drop <think>…</think> blocks some reasoning models emit.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = t.match(/^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/);
  if (m) return m[1];
  return t.replace(/^\s*```[\w+-]*\n/, '').replace(/\n?```\s*$/, '');
}

/** Clean an inline-edit answer. Keeps the original's trailing-newline shape so the surrounding file stays intact. */
export function cleanEdit(out: string, original: string): string {
  let t = stripFences(out);
  t = t.replace(/^\n+/, '').replace(/\s+$/, '');
  if (original.endsWith('\n')) t += '\n';
  return t;
}

export interface EditRequest {
  path?: string;
  language: string;
  instruction: string;
  before: string;
  code: string;
  after: string;
}

export function editMessages(r: EditRequest): { role: 'system' | 'user'; content: string }[] {
  const generating = r.code.trim() === '';
  const system = generating
    ? 'You are a precise code generation engine inside an editor. Write the code requested and nothing else. Match the surrounding style, indentation and naming. Output ONLY the code to insert: no markdown fences, no explanations, no comments about what you did.'
    : 'You are a precise code editing engine inside an editor. Rewrite the SELECTED code so it satisfies the instruction. Keep everything the instruction does not mention unchanged, and keep the indentation style. Output ONLY the full replacement for the selected code: no markdown fences, no explanations.';
  const parts = [
    `File: ${r.path || '(unsaved)'}`,
    `Language: ${r.language}`,
    `Instruction: ${r.instruction}`,
    '',
    'Code before the selection (context only, do not repeat it):',
    r.before || '(start of file)',
    '',
    generating ? 'Insert the new code at this point (nothing is selected).' : 'SELECTED code to rewrite:',
    ...(generating ? [] : [r.code]),
    '',
    'Code after the selection (context only, do not repeat it):',
    r.after || '(end of file)',
  ];
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ];
}

export interface CompleteRequest {
  path?: string;
  language: string;
  prefix: string;
  suffix: string;
}

export function completeMessages(r: CompleteRequest): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content:
        'You are a code completion engine. Continue the code at <CURSOR>. Output ONLY the text to insert at the cursor: no markdown, no explanation, never repeat code that is already before the cursor. Prefer finishing the current line, then at most a few more lines. Output nothing if unsure.',
    },
    { role: 'user', content: `File: ${r.path || '(unsaved)'}\nLanguage: ${r.language}\n\n${r.prefix}<CURSOR>${r.suffix}` },
  ];
}

/** Clean a completion: strip fences, drop an echoed copy of the line start, cap the length. */
export function cleanCompletion(out: string, linePrefix: string, lineSuffix: string, maxLines = 8): string {
  let t = stripFences(out);
  t = t.replace(/^\n+(?=\S)/, (m) => (linePrefix.trim() === '' ? '' : m));
  // Models often re-type the start of the current line; remove that echo.
  const lead = linePrefix.trimStart();
  if (lead && t.trimStart().startsWith(lead)) t = t.trimStart().slice(lead.length);
  else if (lead && t.startsWith(linePrefix)) t = t.slice(linePrefix.length);
  const lines = t.split('\n');
  if (lines.length > maxLines) t = lines.slice(0, maxLines).join('\n');
  t = t.replace(/\s+$/, '');
  // Do not duplicate text that already follows the cursor on this line.
  const rest = lineSuffix.trim();
  if (rest && t.endsWith(rest)) t = t.slice(0, t.length - rest.length).replace(/\s+$/, '');
  return t.trim() === '' ? '' : t;
}

/** Cheap gate so we do not call a model for every keystroke. */
export function shouldAutocomplete(linePrefix: string, lineSuffix: string): boolean {
  if (linePrefix.trim() === '' && lineSuffix.trim() === '') return false; // blank line: wait until something is typed
  // Only when the cursor is at the end of the line or just before closing brackets/quotes.
  if (lineSuffix.trim() !== '' && !/^[\s)\]}>"'`;,]*$/.test(lineSuffix)) return false;
  if (linePrefix.trim().length < 2) return false;
  return true;
}
