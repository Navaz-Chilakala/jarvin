// Build first. Exercise the production tools, workers, PDF printer, and offline English OCR.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dir = process.versions.electron ? process.env.JARVIN_OFFICE_FIXTURE : fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-office-'));
if (!process.versions.electron) {
  const esbuild = require('esbuild');
  const out = '.test-out';
  esbuild.buildSync({ entryPoints: ['src/main/tools.ts'], bundle: true, platform: 'node', packages: 'external', outfile: path.join(out, 'office-tools.cjs') });
  for (const file of ['office-worker.js', 'doc-worker.js']) fs.copyFileSync(path.join('dist', file), path.join(out, file));
  const r = spawnSync(require('electron'), [__filename, '--user-data-dir=' + path.join(dir, 'profile')], { stdio: 'inherit', windowsHide: true, env: { ...process.env, JARVIN_OFFICE_FIXTURE: dir } });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(r.status ?? 1);
}
const { app } = require('electron');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const tools = require('../.test-out/office-tools.cjs').builtinTools;
  const run = (name, args) => tools.find(t => t.name === name).run(args, { root: dir, signal: AbortSignal.timeout(60_000) });
  const text = 'Quarterly sales report';
  for (const ext of ['docx', 'xlsx', 'pptx', 'pdf']) {
    const file = 'sample.' + ext;
    await run('create_document', { path: file, content: text });
    await assert.rejects(run('create_document', { path: file, content: 'duplicate' }), /already exists/);
    assert.match(await run('read_' + ext, { path: file }), /Quarterly sales report/);
    if (ext === 'pdf') {
      const result = await run('ocr_document', { path: file });
      assert.match(result, /Quarterly sales report/i);
    } else {
      await run('edit_document', { path: file, find: text, cell: 'A1', content: 'Revised sales report' });
      assert.match(await run('read_' + ext, { path: file }), /Revised sales report/);
    }
    console.log(ext + ' round trip passed.');
  }
  const sharp = require('sharp');
  await sharp(Buffer.from('<svg width="800" height="120"><rect width="800" height="120" fill="white"/><text x="20" y="80" font-family="Arial" font-size="60">Jarvin reads this page</text></svg>')).png().toFile(path.join(dir, 'scan.png'));
  assert.match(await run('ocr_document', { path: 'scan.png' }), /reads this page/i);
  console.log('Image OCR passed.');
}).then(() => app.exit(0), e => { console.error(e); app.exit(1); });
