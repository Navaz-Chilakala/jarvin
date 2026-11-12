import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { resolveSafe } from './sandbox';
import type { OfficeInput } from './office-worker';
import type { ToolCtx } from './tools';
import { readDocument } from './documents';

async function pdf(text: string): Promise<Buffer> {
  const view = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, nodeIntegration: false, partition: 'jarvin-pdf' } });
  try {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = '<meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>@page{margin:18mm}body{font:11pt/1.45 sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}</style><body>' + escaped + '</body>';
    await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await view.webContents.printToPDF({ pageSize: 'A4', preferCSSPageSize: true });
  } finally { view.destroy(); }
}

export async function writeOffice(ctx: ToolCtx, rel: string, data: OfficeInput, edit: boolean) {
  if (typeof data.content !== 'string' || data.content.length > 200_000) throw Error('Provide up to 200,000 characters of document content.');
  const file = resolveSafe(ctx.root, rel, { write: true });
  const ext = path.extname(file).toLowerCase();
  if (!['.docx', '.xlsx', '.pptx', '.pdf'].includes(ext) || (edit && ext === '.pdf')) throw Error('Choose DOCX, XLSX, PPTX, or a new PDF.');
  if (!edit && fs.existsSync(file)) throw Error('File already exists. Choose another name or edit the document.');
  if (edit && ext === '.xlsx' && !data.cell) throw Error('Give the first cell to update.');
  if (edit && fs.statSync(file).size > 20 * 1024 * 1024) throw Error('Editing is limited to files up to 20 MB.');
  const original = edit ? fs.readFileSync(file) : undefined;
  ctx.signal.throwIfAborted();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.jarvin-' + randomUUID() + '.tmp');
  try {
    if (ext === '.pdf') fs.writeFileSync(tmp, await pdf(data.content), { flag: 'wx' });
    else await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, [path.join(__dirname, 'office-worker.js'), ext, tmp, ...(edit ? [file] : [])], {
        timeout: 60_000, windowsHide: true, signal: ctx.signal, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }, (err, _, stderr) => err ? reject(Error(String(stderr || err.message).slice(0, 1000))) : resolve());
      child.stdin?.on('error', () => {}); // execFile reports worker startup/exit errors.
      child.stdin?.end(JSON.stringify(data));
    });
    ctx.signal.throwIfAborted();
    resolveSafe(ctx.root, rel, { write: true });
    if (original && !fs.readFileSync(file).equals(original)) throw Error('The file changed while preparing the edit. Reopen it and retry.');
    ctx.beforeWrite?.(file);
    if (edit) fs.renameSync(tmp, file);
    else fs.linkSync(tmp, file); // Atomic creation fails if a different writer already claimed the name.
    return `${edit ? 'Updated' : 'Created'} ${path.relative(ctx.root, file)}`;
  } finally { fs.rmSync(tmp, { force: true }); }
}

export async function recognizeFile(file: string, page: number, signal: AbortSignal): Promise<string> {
  if (!/\.(pdf|png|jpe?g|bmp|tiff?)$/i.test(file) || !Number.isSafeInteger(page) || page < 1) throw Error('Choose an image or PDF and a positive page number.');
  if (fs.statSync(file).size > 50 * 1024 * 1024) throw Error('OCR input exceeds 50 MB.');
  return readDocument('ocr', file, signal, { page });
}
