import fs from 'node:fs';
import path from 'node:path';

export interface VerificationCommand {
  framework: string;
  command: string;
  reason: string;
}

export interface VerificationStats {
  passed?: number;
  failed?: number;
  total?: number;
}

export interface VerificationFailure {
  location: string;
  text?: string;
}

export function detectVerificationCommand(root: string): VerificationCommand | null {
  const pkgPath = path.join(root, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg?.scripts?.test && String(pkg.scripts.test).trim() && !/^echo\s+"?Error/i.test(String(pkg.scripts.test))) {
      const runner = fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn test' : fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm test' : 'npm test';
      return { framework: 'npm', command: runner, reason: 'package.json scripts.test' };
    }
  } catch { /* no package.json */ }

  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return { framework: 'cargo', command: 'cargo test', reason: 'Cargo.toml' };
  if (fs.existsSync(path.join(root, 'go.mod'))) return { framework: 'go', command: 'go test ./...', reason: 'go.mod' };
  if (['pom.xml', 'build.gradle', 'build.gradle.kts'].some((f) => fs.existsSync(path.join(root, f)))) {
    return { framework: 'maven/gradle', command: fs.existsSync(path.join(root, 'pom.xml')) ? 'mvn test' : 'gradle test', reason: 'Java build file' };
  }
  const csproj = ((): string | null => {
    try { return fs.readdirSync(root).find((n) => n.endsWith('.csproj')) ?? null; } catch { return null; }
  })();
  if (csproj) return { framework: 'dotnet', command: 'dotnet test', reason: csproj };

  const pyHints = ['pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml'];
  const requirements = (() => {
    try { return fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8'); } catch { return ''; }
  })();
  if (pyHints.some((f) => fs.existsSync(path.join(root, f))) || /pytest/i.test(requirements) || hasTests(root, /test_.*\.py$|.*_test\.py$/)) {
    return { framework: 'pytest', command: 'python -m pytest -q', reason: 'Python project/test files' };
  }

  // JavaScript projects without an explicit test script but with common test folders.
  if (hasTests(root, /\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/)) {
    if (fs.existsSync(path.join(root, 'vitest.config.ts')) || fs.existsSync(path.join(root, 'vitest.config.js'))) return { framework: 'vitest', command: 'npx vitest run', reason: 'Vitest test files' };
    return { framework: 'jest', command: 'npx jest', reason: 'Jest-style test files' };
  }
  return null;
}

function hasTests(root: string, matcher: RegExp, max = 2000): boolean {
  let found = false;
  const walk = (dir: string): void => {
    if (found) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (matcher.test(e.name)) found = true;
      if (found) return;
    }
  };
  walk(root);
  return found;
}

export function parseVerificationStats(output: string): VerificationStats {
  const text = String(output ?? '');
  const patterns: { re: RegExp; failed: number; passed: number }[] = [
    { re: /Tests:\s*(\d+)\s*failed.*?(\d+)\s*passed/i, failed: 1, passed: 2 },
    { re: /(\d+)\s*passed,\s*(\d+)\s*failed/i, passed: 1, failed: 2 },
    { re: /(\d+)\s*failed,\s*(\d+)\s*passed/i, failed: 1, passed: 2 },
    { re: /(\d+)\s*passed;\s*(\d+)\s*failed/i, passed: 1, failed: 2 },
    { re: /test result:\s*(?:ok|FAILED)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed/i, passed: 1, failed: 2 },
  ];
  for (const { re, failed, passed } of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const p = Number(m[passed]);
    const f = Number(m[failed]);
    if (Number.isFinite(p) && Number.isFinite(f)) return { passed: p, failed: f, total: p + f };
  }
  const simple = text.match(/(\d+)\s*(?:tests?\s*)?passed/i);
  if (simple) return { passed: Number(simple[1]), failed: 0, total: Number(simple[1]) };
  return {};
}

export function parseVerificationFailures(output: string, limit = 30): VerificationFailure[] {
  const text = String(output ?? '');
  const found = new Map<string, VerificationFailure>();
  const add = (location: string, lineText?: string) => {
    const clean = String(location ?? '').trim().replace(/^[-*]\s*/, '');
    if (!clean || found.size >= limit) return;
    found.set(clean, { location: clean, text: lineText ? String(lineText).trim().slice(0, 240) : undefined });
  };

  for (const m of text.matchAll(/\b([A-Za-z0-9_./\\-]+\.(?:[cm]?[jt]sx?|py|rs|go|cs|java|rb|php)):(\d+)(?::\d+)?/g)) {
    add(`${m[1]}:${m[2]}`);
  }
  for (const m of text.matchAll(/FAILED\s+([^\s]+::[^\s]+)/g)) add(String(m[1]));
  for (const m of text.matchAll(/^\s*(?:FAIL|FAILED)\s+(\S+)/gm)) add(String(m[1]));
  for (const m of text.matchAll(/---\s*FAIL:\s*(\S+)/g)) add(String(m[1]));
  for (const m of text.matchAll(/^\s*(?:✕|×|✗)\s+(.+)$/gm)) add(String(m[1]));
  return [...found.values()];
}
