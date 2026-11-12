import fs from 'node:fs';
import path from 'node:path';
import { resolveSafe } from './sandbox';

export interface PatchHunk {
  oldLines: string[];
  newLines: string[];
  raw: string[];
}

export interface PatchHunkSummary {
  key: string;
  path: string;
  type: 'add' | 'delete' | 'update';
  oldText: string;
  newText: string;
}

export interface PatchOp {
  type: 'add' | 'delete' | 'update';
  path: string;
  move?: string;
  hunks: PatchHunk[];
}

export interface PatchApplyResult {
  changed: string[];
  deleted: string[];
  added: string[];
}

function splitLines(s: string): string[] {
  const normalized = s.replace(/\r\n/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function parseHunk(lines: string[]): PatchHunk {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('\\')) continue; // "\ No newline..." etc.
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const value = line.slice(1);
      oldLines.push(value);
      newLines.push(value);
    } else {
      // Lines without a marker are treated as context.
      oldLines.push(line);
      newLines.push(line);
    }
  }
  return { oldLines, newLines, raw: [...lines] };
}

export function parsePatch(patch: string): PatchOp[] {
  const lines = patch.split(/\r?\n/);
  if (lines[0]?.trim() !== '*** Begin Patch') throw new Error('patch must start with "*** Begin Patch"');
  const ops: PatchOp[] = [];
  let i = 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '*** End Patch') break;
    const addMatch = line.match(/^\*\*\* Add File:\s*(.+?)\s*$/);
    const delMatch = line.match(/^\*\*\* Delete File:\s*(.+?)\s*$/);
    const updMatch = line.match(/^\*\*\* Update File:\s*(.+?)\s*$/);
    if (addMatch) {
      i++;
      const contentLines: string[] = [];
      const rawLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        const entry = lines[i];
        contentLines.push(entry.startsWith('+') ? entry.slice(1) : entry);
        rawLines.push(entry.startsWith('+') ? entry : '+' + entry);
        i++;
      }
      ops.push({ type: 'add', path: addMatch[1], hunks: [{ oldLines: [], newLines: contentLines, raw: rawLines }] });
      continue;
    }
    if (delMatch) {
      i++;
      ops.push({ type: 'delete', path: delMatch[1], hunks: [] });
      continue;
    }
    if (updMatch) {
      const opPath = updMatch[1];
      i++;
      let move: string | undefined;
      const moveMatch = lines[i]?.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
      if (moveMatch) {
        move = moveMatch[1];
        i++;
      }
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        body.push(lines[i]);
        i++;
      }
      // Split body into hunks at @@ markers.
      const hunkBodies: string[][] = [];
      let current: string[] = [];
      for (const entry of body) {
        if (entry.startsWith('@@')) {
          if (current.length) hunkBodies.push(current);
          current = [];
        } else {
          current.push(entry);
        }
      }
      if (current.length) hunkBodies.push(current);
      if (!hunkBodies.length && body.length) hunkBodies.push(body);
      const hunks = hunkBodies.map(parseHunk).filter((h) => h.oldLines.length || h.newLines.length);
      ops.push({ type: 'update', path: opPath, move, hunks: hunks.length ? hunks : [{ oldLines: [], newLines: [], raw: [] }] });
      continue;
    }
    i++;
  }
  if (!ops.length) throw new Error('patch contains no operations');
  return ops;
}

function findLines(lines: string[], target: string[], cursor: number): number {
  if (!target.length) return -1;
  const max = lines.length - target.length;
  // Search forward from cursor first, then from the start.
  const ranges: [number, number][] = [[Math.max(0, cursor), max + 1]];
  if (cursor > 0) ranges.push([0, Math.max(0, cursor)]);
  for (const [s, e] of ranges) {
    outer: for (let i = Math.max(s, 0); i < e; i++) {
      for (let j = 0; j < target.length; j++) {
        if (lines[i + j] !== target[j]) continue outer;
      }
      return i;
    }
  }
  return -1;
}

export function applyPatch(ctx: { root: string; beforeWrite?: (file: string) => void }, patch: string): { result: PatchApplyResult; summary: string } {
  const ops = parsePatch(patch);
  // Validate and build the new contents before touching disk.
  const existingPaths = new Set<string>();
  const writes = new Map<string, { path: string; before: string | null; content: string | null; create: boolean }>();
  const deletes = new Set<string>();

  for (const op of ops) {
    const abs = resolveSafe(ctx.root, op.path, { write: true });
    const rel = path.relative(ctx.root, abs).split(path.sep).join('/');
    if (op.type === 'add') {
      if (fs.existsSync(abs)) throw new Error(`cannot add existing file: ${rel}`);
      const content = op.hunks[0]?.newLines.join('\n') ?? '';
      writes.set(rel, { path: abs, before: null, content, create: true });
    } else if (op.type === 'delete') {
      if (!fs.existsSync(abs)) throw new Error(`cannot delete missing file: ${rel}`);
      if (writes.get(rel)?.create) writes.delete(rel);
      deletes.add(rel);
    } else {
      if (!fs.existsSync(abs)) throw new Error(`cannot update missing file: ${rel}`);
      const text = fs.readFileSync(abs, 'utf8');
      const lines = splitLines(text);
      let result = [...lines];
      let cursor = 0;
      for (const hunk of op.hunks) {
        if (!hunk.oldLines.length) {
          if (hunk.newLines.length) {
            const insertAt = hunk.newLines.length && cursor > 0 ? Math.min(cursor, result.length) : result.length;
            result.splice(insertAt, 0, ...hunk.newLines);
            cursor = insertAt + hunk.newLines.length;
          }
          continue;
        }
        const idx = findLines(result, hunk.oldLines, cursor);
        if (idx === -1) throw new Error(`hunk did not match in ${rel}: ${JSON.stringify(hunk.oldLines.slice(0, 3))}`);
        result.splice(idx, hunk.oldLines.length, ...hunk.newLines);
        cursor = idx + hunk.newLines.length;
      }
      const newline = text.endsWith('\n') ? '\n' : '';
      const newContent = result.join('\n') + newline;
      const destination = op.move ? path.join(ctx.root, op.move) : null;
      const destinationRel = op.move ? String(op.move).split(path.sep).join('/') : rel;
      if (op.move) {
        const destAbs = resolveSafe(ctx.root, op.move, { write: true });
        if (fs.existsSync(destAbs) && destinationRel !== rel) throw new Error(`move target already exists: ${destinationRel}`);
        writes.set(rel, { path: abs, before: text, content: null, create: false }); // deletion
        writes.set(destinationRel, { path: destAbs, before: fs.existsSync(destAbs) ? fs.readFileSync(destAbs, 'utf8') : null, content: newContent, create: !fs.existsSync(destAbs) });
        if (deletes.has(rel)) throw new Error(`file both updated and deleted: ${rel}`);
        // The source should be removed.
        deletes.add(rel);
      } else {
        writes.set(rel, { path: abs, before: text, content: newContent, create: false });
      }
    }
  }

  // Apply deletes actually after writes; but track.
  // Validate there are no conflicting write paths.
  for (const p of writes.keys()) {
    if (deletes.has(p) && writes.get(p)?.content !== null) {
      throw new Error(`internal patch conflict: ${p}`);
    }
  }

  // Write all planned files.
  for (const [rel, info] of writes.entries()) {
    if (info.content === null) continue; // deleted source scheduled above
    ctx.beforeWrite?.(info.path);
    if ((info.before === null || info.create) && !fs.existsSync(info.path)) {
      fs.mkdirSync(path.dirname(info.path), { recursive: true });
    }
    fs.writeFileSync(info.path, info.content);
  }
  for (const rel of deletes) {
    const info = writes.get(rel);
    const abs = info?.path ?? resolveSafe(ctx.root, rel, { write: true });
    if (fs.existsSync(abs)) {
      ctx.beforeWrite?.(abs);
      fs.rmSync(abs, { force: true });
    }
    writes.delete(rel);
  }

  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const op of ops) {
    const rel = op.path.split(path.sep).join('/');
    if (op.type === 'add') added.push(op.path);
    else if (op.type === 'delete') deleted.push(op.path);
    else changed.push(op.move ? `${op.path} -> ${op.move}` : op.path);
  }
  return { result: { changed, deleted, added }, summary: `Patch applied: ${added.length} added, ${changed.length} updated, ${deleted.length} deleted.` };
}

export function listPatchHunks(patch: string): PatchHunkSummary[] {
  const out: PatchHunkSummary[] = [];
  for (const op of parsePatch(patch)) {
    if (op.type === 'delete') {
      out.push({ key: `${op.path}|delete|0`, path: op.path, type: op.type, oldText: '', newText: '' });
    } else if (op.type === 'add') {
      const h = op.hunks[0];
      out.push({ key: `${op.path}|add|0`, path: op.path, type: op.type, oldText: '', newText: (h?.newLines ?? []).join('\n') });
    } else {
      op.hunks.forEach((h, i) => out.push({ key: `${op.path}|update|${i}`, path: op.path, type: op.type, oldText: h.oldLines.join('\n'), newText: h.newLines.join('\n') }));
    }
  }
  return out;
}

export function filterPatch(patch: string, keepKeys: string[]): string {
  const keep = new Set(keepKeys ?? []);
  const ops = parsePatch(patch);
  const out: string[] = ['*** Begin Patch'];
  for (const op of ops) {
    if (op.type === 'add') {
      if (!keep.has(`${op.path}|add|0`)) continue;
      out.push(`*** Add File: ${op.path}`);
      for (const h of op.hunks) for (const line of h.raw.length ? h.raw : h.newLines.map((l) => '+' + l)) out.push(line);
    } else if (op.type === 'delete') {
      if (!keep.has(`${op.path}|delete|0`)) continue;
      out.push(`*** Delete File: ${op.path}`);
    } else {
      const keptHunks = op.hunks.filter((h, i) => keep.has(`${op.path}|update|${i}`));
      if (!keptHunks.length) continue;
      out.push(`*** Update File: ${op.path}`);
      if (op.move) out.push(`*** Move to: ${op.move}`);
      for (const h of keptHunks) {
        out.push('@@');
        for (const line of h.raw) out.push(line);
      }
    }
  }
  out.push('*** End Patch');
  return out.join('\n');
}
