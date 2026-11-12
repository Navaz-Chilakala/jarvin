import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTsc, parseColon, parseEslintJson, parsePyCompile, relPath, dedupe, formatProblems, autoFixPrompt, countBySeverity } from '../src/shared/problems';

test('parseTsc reads file(line,col) errors and joins continuation lines', () => {
  const out = "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n  Type X is not Y.\nsrc/b.ts(3,1): warning TS6133: 'x' is declared but never used.\nFound 2 errors.";
  const p = parseTsc(out);
  assert.equal(p.length, 2);
  assert.deepEqual([p[0].file, p[0].line, p[0].col, p[0].severity, p[0].code], ['src/a.ts', 12, 5, 'error', 'TS2322']);
  assert.match(p[0].message, /not assignable.*Type X is not Y/);
  assert.equal(p[1].severity, 'warning');
});

test('parseTsc makes absolute Windows paths workspace-relative', () => {
  const p = parseTsc("C:\\Users\\N\\proj\\src\\a.ts(1,2): error TS1005: ';' expected.", 'C:\\Users\\N\\proj');
  assert.equal(p[0].file, 'src/a.ts');
});

test('parseColon handles go vet, cargo short and Windows drive letters', () => {
  const go = parseColon('./main.go:10:2: undefined: foo\n# pkg', 'go vet');
  assert.deepEqual([go[0].file, go[0].line, go[0].col, go[0].severity], ['main.go', 10, 2, 'error']);
  const rs = parseColon('src/lib.rs:4:9: error[E0308]: mismatched types\nsrc/lib.rs:7:1: warning: unused variable', 'cargo');
  assert.equal(rs[0].code, 'E0308');
  assert.equal(rs[0].message, 'mismatched types');
  assert.equal(rs[1].severity, 'warning');
  const win = parseColon('C:\\p\\x.go:3:4: bad thing', 'go vet', 'C:\\p');
  assert.equal(win[0].file, 'x.go');
});

test('parseEslintJson maps severities', () => {
  const j = JSON.stringify([{ filePath: '/w/src/a.js', messages: [{ line: 2, column: 3, severity: 2, message: 'no-undef', ruleId: 'no-undef' }, { line: 5, column: 1, severity: 1, message: 'meh', ruleId: 'x' }] }]);
  const p = parseEslintJson('noise\n' + j, '/w');
  assert.deepEqual(p.map((x) => [x.file, x.severity, x.code]), [['src/a.js', 'error', 'no-undef'], ['src/a.js', 'warning', 'x']]);
});

test('parsePyCompile finds syntax errors', () => {
  const out = '  File "app.py", line 3\n    def (:\n        ^\nSyntaxError: invalid syntax\n';
  const p = parsePyCompile(out);
  assert.deepEqual([p[0].file, p[0].line, p[0].message], ['app.py', 3, 'SyntaxError: invalid syntax']);
});

test('helpers', () => {
  assert.equal(relPath('./a\\b.ts', ''), 'a/b.ts');
  const p = parseTsc("a.ts(1,1): error TS1: x\na.ts(1,1): error TS1: x");
  assert.equal(dedupe(p).length, 1);
  assert.deepEqual(countBySeverity(p), { errors: 2, warnings: 0 });
  assert.match(formatProblems(p, 1), /a\.ts:1:1 error TS1 \[typescript\] x/);
  assert.match(autoFixPrompt(p, 0), /Automatic check 1\].*2 errors/s);
});
