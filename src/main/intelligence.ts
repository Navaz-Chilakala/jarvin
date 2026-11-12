import fs from 'node:fs';
import path from 'node:path';

const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', '.cache', 'release']);

export async function workspaceSymbols(root: string, query: string, limit = 200): Promise<{ path: string; name: string; kind: string; line: number; column: number }[]> {
  const low = String(query ?? '').toLowerCase();
  const out: { path: string; name: string; kind: string; line: number; column: number; score: number }[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s;:{}(),])(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|struct)\s+([A-Za-z_$][\w$]*)/g;
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= Math.max(limit * 4, 400)) return;
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        await walk(full);
      } else {
        let st: fs.Stats;
        try { st = await fs.promises.stat(full); } catch { continue; }
        if (!st.isFile() || st.size > 2_000_000) continue;
        let text = '';
        try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
        if (text.includes('\0')) continue;
        const lines = text.split(/\r?\n/).slice(0, 12000);
        for (let i = 0; i < lines.length; i++) {
          let m: RegExpExecArray | null;
          while ((m = re.exec(lines[i])) !== null) {
            const name = String(m[1] ?? '');
            if (!name) continue;
            if (low && !name.toLowerCase().includes(low)) continue;
            const key = `${rel}:${i + 1}:${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const exact = name.toLowerCase() === low;
            out.push({ path: rel, name, kind: /class/i.test(String(m[0])) ? 'class' : /interface|type/i.test(String(m[0])) ? 'type' : 'symbol', line: i + 1, column: 1, score: exact ? 0 : (name.toLowerCase().startsWith(low) ? 1 : 2) });
            if (out.length >= 600) break;
          }
          re.lastIndex = 0;
          if (out.length >= 600) break;
        }
      }
      if (out.length >= 600) break;
    }
  };
  if (root) await walk(root);
  out.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return out.slice(0, limit).map(({ score, ...rest }) => rest);
}