import fs from 'node:fs';
import path from 'node:path';

export interface FoundFile { path: string; name: string; folder: boolean; size: number; modified: string }

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'appdata', '$recycle.bin']);
/** File types that run code when opened; the assistant must never launch these on its own. */
const RUNNABLE = /\.(exe|msi|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|scr|reg|lnk|jar|hta|dll)$/i;

/** Finds files and folders whose name contains every word of the query, newest first. */
export async function searchUserFiles(query: string, roots: string[], o: { limit?: number; maxDepth?: number; budgetMs?: number } = {}): Promise<FoundFile[]> {
  const words = query.toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
  if (!words.length) return [];
  const limit = o.limit ?? 10, maxDepth = o.maxDepth ?? 4, deadline = Date.now() + (o.budgetMs ?? 4000);
  const hits: FoundFile[] = [];
  let scanned = 0;
  async function walk(dir: string, depth: number) {
    if (Date.now() > deadline || scanned > 30000) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      scanned++;
      if (SKIP.has(e.name.toLowerCase()) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const lower = e.name.toLowerCase();
      if (words.every((w) => lower.includes(w))) {
        try {
          const st = await fs.promises.stat(full);
          hits.push({ path: full, name: e.name, folder: e.isDirectory(), size: st.size, modified: st.mtime.toISOString().slice(0, 10) });
        } catch { /* unreadable */ }
      }
      if (e.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
    }
  }
  for (const root of roots) await walk(root, 0);
  return hits.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit);
}

/** Returns an error message when the path may not be opened by the assistant, else ''. */
export function openBlocked(target: string, roots: string[]): string {
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const t = norm(target);
  if (!path.isAbsolute(target)) return 'Give the full path returned by find_user_file.';
  if (!roots.some((r) => t === norm(r) || t.startsWith(norm(r) + path.sep))) return 'Only files inside Desktop, Documents or Downloads can be opened.';
  if (RUNNABLE.test(t)) return 'This file type runs code, so it will not be opened automatically. Ask the user to open it.';
  if (!fs.existsSync(target)) return 'That path does not exist.';
  return '';
}
