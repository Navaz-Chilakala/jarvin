import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function memoryDir(): string {
  if (process.env.JARVIN_E2E === '1' && process.env.JARVIN_E2E_DATA_DIR) return path.join(process.env.JARVIN_E2E_DATA_DIR, 'memory');
  return path.join(os.homedir(), '.jarvin', 'memory');
}
function ensureDir(): string {
  const d = memoryDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}
function slug(name: string): string {
  const value = String(name || 'memory').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'memory';
  return value === 'memory' ? 'memory-item' : value;
}
export function memoryFile(name: string): string {
  return path.join(memoryDir(), slug(name) + '.md');
}
export function listMemoryFiles(d = memoryDir()): { name: string; description: string; type: string; file: string }[] {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  const out: { name: string; description: string; type: string; file: string }[] = [];
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const f = entry.name;
    if (!entry.isFile() || !f.endsWith('.md') || f.toLowerCase() === 'memory.md') continue;
    const full = path.join(d, f);
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    let name = f.replace(/\.md$/, '');
    let description = '';
    let type = 'project';
    if (m) {
      for (const line of m[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) {
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          if (k === 'name') name = v || name;
          if (k === 'description') description = v;
          if (k === 'type') type = v || type;
        }
      }
    }
    out.push({ name, description, type, file: full });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export function readMemoryIndex(): string {
  const d = memoryDir();
  try {
    return fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}
export function rebuildMemoryIndex(d = ensureDir()): void {
  const files = listMemoryFiles(d);
  const lines = files.map((f) => `- [${f.name}](${path.basename(f.file)}) — ${f.description || f.type}`);
  try { fs.writeFileSync(path.join(d, 'MEMORY.md'), lines.join('\n') + (lines.length ? '\n' : '')); } catch { /* ignore */ }
}
export function saveMemory(name: string, description: string, type: string, content: string): string {
  const d = ensureDir();
  const n = slug(name);
  const full = path.join(d, n + '.md');
  const fm = `---\nname: ${n}\ndescription: ${String(description || '').replace(/\n/g, ' ')}\ntype: ${type || 'project'}\n---\n\n${content ?? ''}\n`;
  fs.writeFileSync(full, fm);
  rebuildMemoryIndex();
  return full;
}
export function readMemory(name: string): string | null {
  try {
    return fs.readFileSync(memoryFile(name), 'utf8');
  } catch {
    return null;
  }
}
export function deleteMemory(name: string): boolean {
  const full = memoryFile(name);
  try { fs.rmSync(full, { force: true }); } catch { return false; }
  rebuildMemoryIndex();
  return true;
}

export interface MemoryInfo { id: string; name: string; description: string; type: string }
export interface MemoryContent { text: string; revision: string }

function managedPath(id: unknown, root: string): string {
  if (typeof id !== 'string' || !/^[a-z0-9._-]{1,160}$/i.test(id) || id.toLowerCase() === 'memory') {
    throw new Error('Invalid memory identifier.');
  }
  const file = path.join(root, id + '.md');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('This memory is not a regular file.');
  if (stat.size > 256 * 1024) throw new Error('This memory is too large to edit here.');
  return file;
}

function splitMemory(raw: string): { header: string; text: string } {
  const m = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)(?:\r?\n)?([\s\S]*)$/.exec(raw);
  return m ? { header: m[1], text: m[2] } : { header: '', text: raw };
}

const revisionOf = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');

/** List only IDs, not filesystem paths, across the UI boundary. */
export function listManagedMemories(root = memoryDir()): MemoryInfo[] {
  return listMemoryFiles(root).map((m) => ({ id: path.basename(m.file).slice(0, -3), name: m.name, description: m.description, type: m.type }));
}

export function readManagedMemory(id: unknown, root = memoryDir()): MemoryContent {
  const raw = fs.readFileSync(managedPath(id, root), 'utf8');
  return { text: splitMemory(raw).text, revision: revisionOf(raw) };
}

/** Compare the previously read revision before any write or delete. */
export function updateManagedMemory(id: unknown, revision: unknown, text: unknown, root = memoryDir()): void {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) throw new Error('Invalid memory content or revision.');
  const file = managedPath(id, root);
  const raw = fs.readFileSync(file, 'utf8');
  if (revisionOf(raw) !== revision) throw new Error('This memory changed since it was opened. Refresh before saving.');
  const { header } = splitMemory(raw);
  fs.writeFileSync(file, header ? `${header}\n${text}` : text, 'utf8');
  rebuildMemoryIndex(root);
}

export function deleteManagedMemory(id: unknown, revision: unknown, root = memoryDir()): void {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid memory revision.');
  const file = managedPath(id, root);
  if (revisionOf(fs.readFileSync(file, 'utf8')) !== revision) throw new Error('This memory changed since it was opened. Refresh before deleting.');
  fs.unlinkSync(file);
  rebuildMemoryIndex(root);
}
