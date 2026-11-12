/**
 * Tidies what a model hands to create_document / edit_document before it is written, and says what shape it has.
 * Small models often send the two characters backslash-t instead of a real tab, or use commas or pipes between cells;
 * unfixed, a whole table lands in cell A1 and the tool still reports success.
 */
export function normalizeOfficeContent(ext: string, raw: string): { content: string; shape: string } {
  let content = raw.replace(/\r\n?/g, '\n');
  // Escaped line breaks, when the text has no real ones. A spreadsheet needs them to have rows at all; in other
  // documents one "\n" could be part of a Windows path (C:\new), so two or more are required there.
  const escapedBreaks = (content.match(/\\n/g) ?? []).length;
  if (!content.includes('\n') && escapedBreaks >= (ext === '.xlsx' ? 1 : 2)) content = content.replace(/\\r/g, '').replace(/\\n/g, '\n');
  // Escaped tabs only mean cells, so they are only converted for spreadsheets.
  if (ext === '.xlsx' && !content.includes('\t') && /\\t/.test(content)) content = content.replace(/\\t/g, '\t');
  const lines = content.split('\n');
  if (ext === '.xlsx') {
    const rows = lines.filter((l) => l.trim());
    if (!content.includes('\t') && rows.length) {
      // A markdown-style table or comma-separated rows: accept either when every row uses it.
      const piped = rows.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l));
      if (piped.every((l) => l.includes('|'))) content = piped.map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).join('\t')).join('\n');
      else if (rows.every((l) => l.includes(','))) content = rows.map((l) => l.split(',').map((c) => c.trim()).join('\t')).join('\n');
    }
    const table = content.split('\n').filter((l) => l.trim()).map((l) => l.split('\t'));
    const columns = table.reduce((n, r) => Math.max(n, r.length), 0);
    return { content, shape: `${table.length} row${table.length === 1 ? '' : 's'} x ${columns} column${columns === 1 ? '' : 's'}` };
  }
  if (ext === '.pptx') {
    const slides = content.split(/^---\s*$/m).filter((s) => s.trim()).length;
    return { content, shape: `${slides} slide${slides === 1 ? '' : 's'}` };
  }
  const filled = lines.filter((l) => l.trim()).length;
  return { content, shape: `${filled} line${filled === 1 ? '' : 's'} of text` };
}
