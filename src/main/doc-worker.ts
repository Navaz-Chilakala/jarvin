import fs from 'node:fs';
// worker_threads is optional: when run as a worker (parentPort present) we postMessage,
// otherwise (child process) we print JSON to stdout.
let parentPort: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  parentPort = require('node:worker_threads').parentPort;
  // force module load side effects? parentPort is already defined.
} catch {
  parentPort = null;
}

const pdfModule = require('pdf-parse');
const mammoth = require('mammoth');

async function emit(result: any) {
  if (parentPort) parentPort.postMessage(result);
  else {
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  }
}

async function main() {
  let kind = '';
  let file = '';
  if (parentPort && (globalThis as any).workerData) {
    const wd = (globalThis as any).workerData;
    kind = wd.kind; file = wd.file;
  } else {
    kind = process.argv[2] || '';
    file = process.argv[3] || '';
  }
  const buf = fs.readFileSync(file);
  if (kind === 'ocr') {
    const page = Number(process.argv[4] || 1);
    let image = buf;
    if (/\.pdf$/i.test(file)) {
      const pdf = new pdfModule.PDFParse({ data: buf });
      try {
        const snapshot = await pdf.getScreenshot({ partial: [page], desiredWidth: 1600, imageDataUrl: false });
        if (!snapshot.pages.length) throw Error('PDF page not found.');
        image = Buffer.from(snapshot.pages[0].data);
      } finally { await pdf.destroy(); }
    } else if (page !== 1) throw Error('Choose page 1 for an image.');
    const { createWorker } = require('tesseract.js');
    const { langPath } = require('@tesseract.js-data/eng');
    const ocr = await createWorker('eng', 1, { langPath, cacheMethod: 'none' });
    let text: string;
    try { text = (await ocr.recognize(image)).data.text.trim(); }
    finally { await ocr.terminate(); }
    await emit({ ok: true, text: text || 'No text recognized.' });
    return;
  }
  if (kind === 'pdf') {
    const instance = new pdfModule.PDFParse({ data: buf });
    const data = await instance.getText();
    const pages = Array.isArray(data?.pages) ? data.pages.length : 0;
    try { await instance.destroy?.(); } catch { /* ignore */ }
    await emit({ ok: true, text: String(data.text ?? ''), pages });
    return;
  }
  if (kind === 'docx') {
    const result = await mammoth.convertToMarkdown({ buffer: buf });
    await emit({ ok: true, text: String(result.value ?? '') });
    return;
  }
  await emit({ ok: false, error: `Unsupported document kind: ${kind}` });
}

main().catch((e: any) => {
  const msg = { ok: false, error: String(e?.message ?? e) };
  if (parentPort) parentPort.postMessage(msg);
  else {
    process.stdout.write(JSON.stringify(msg), () => process.exit(1));
  }
});
