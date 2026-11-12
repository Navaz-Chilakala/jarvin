/** Optional integration check: real DOCX and PDF parsing with Electron. Run after npm run build. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocument } from '../src/main/documents';

const JSZip = require('jszip');
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-doc-live-'));
  try {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jarvin document integration check.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
    const file = path.join(dir, 'test.docx');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const executable = require('electron') as string;
    const worker = path.join(process.cwd(), 'dist', 'doc-worker.js');
    const result = await readDocument('docx', file, AbortSignal.timeout(30_000), { executable, worker });
    if (!result.includes('Jarvin document integration check')) throw new Error(`Unexpected document output: ${result}`);
    console.log('DOCX extracted successfully with the Electron executable:', result.trim());

    const content = 'BT /F1 12 Tf 72 720 Td (Jarvin PDF integration check) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const pdfFile = path.join(dir, 'test.pdf');
    fs.writeFileSync(pdfFile, pdf);
    const pdfResult = await readDocument('pdf', pdfFile, AbortSignal.timeout(30_000), { executable, worker });
    if (!pdfResult.includes('Jarvin PDF integration check')) throw new Error(`Unexpected PDF output: ${pdfResult}`);
    console.log('PDF extracted successfully with the Electron executable:', pdfResult.trim());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
