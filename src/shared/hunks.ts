/** Mirrors Monaco's ILineChange: 1-based inclusive line numbers; an end of 0 means "no lines on this side". */
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** Return `modified` with one change put back to what `original` had. */
export function revertHunkText(original: string, modified: string, c: LineChange): string {
  const o = original.split('\n');
  const m = modified.split('\n');
  const replacement = c.originalEndLineNumber === 0 ? [] : o.slice(c.originalStartLineNumber - 1, c.originalEndLineNumber);
  if (c.modifiedEndLineNumber === 0) {
    // pure deletion: the removed lines go back after modified line `modifiedStartLineNumber`
    return [...m.slice(0, c.modifiedStartLineNumber), ...replacement, ...m.slice(c.modifiedStartLineNumber)].join('\n');
  }
  return [...m.slice(0, c.modifiedStartLineNumber - 1), ...replacement, ...m.slice(c.modifiedEndLineNumber)].join('\n');
}

/** Index of the change that contains (or is nearest after) a modified-side line; -1 when there are no changes. */
export function changeAtLine(changes: LineChange[], line: number): number {
  if (!changes.length) return -1;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const start = c.modifiedStartLineNumber;
    const end = c.modifiedEndLineNumber === 0 ? start : c.modifiedEndLineNumber;
    if (line >= start && line <= end) return i;
    if (line < start) return i;
  }
  return changes.length - 1;
}
