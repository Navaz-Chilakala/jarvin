import fs from 'node:fs';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Document, Packer, Paragraph } from 'docx';
import pptxgen from 'pptxgenjs';
const XLSX = require('xlsx-populate');

export interface OfficeInput {
  content: string;
  find?: string;
  sheet?: string;
  cell?: string;
}

// Edit ordinary body or slide text in place, retaining unrelated package parts.
async function replaceRun(input: Buffer, ext: string, find: string, replacement: string) {
  const zip = await JSZip.loadAsync(input);
  const parts = ext === '.docx' ? /^word\/document\.xml$/ : /^ppt\/slides\/slide\d+\.xml$/;
  const ns = ext === '.docx' ? 'http://schemas.openxmlformats.org/wordprocessingml/2006/main' : 'http://schemas.openxmlformats.org/drawingml/2006/main';
  let matches = 0;
  for (const entry of zip.file(parts)) {
    const xml = await entry.async('string');
    if (xml.includes('<!DOCTYPE')) throw Error('Unsupported document XML.');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    let changed = false;
    for (const el of Array.from(doc.getElementsByTagNameNS(ns, 't'))) {
      const text = el.textContent ?? '';
      const pieces = text.split(find);
      if (pieces.length === 1) continue;
      matches += pieces.length - 1;
      if (matches > 1) throw Error('Text occurs more than once. Give a longer unique phrase.');
      el.textContent = pieces.join(replacement);
      if (ext === '.docx') el.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
      changed = true;
    }
    if (changed) zip.file(entry.name, new XMLSerializer().serializeToString(doc));
  }
  if (!matches) throw Error('Could not find that phrase within a single formatted text run.');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function generate(ext: string, data: OfficeInput, input?: Buffer): Promise<Buffer> {
  const lines = data.content.replace(/\r\n?/g, '\n').split('\n');
  if (ext === '.xlsx') {
    const book = input ? await XLSX.fromDataAsync(input) : await XLSX.fromBlankAsync();
    const sheet = book.sheet(data.sheet || 0);
    if (!sheet) throw Error('Worksheet not found.');
    const first = data.cell || 'A1';
    if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/i.test(first)) throw Error('Enter an Excel cell address such as B2.');
    const origin = sheet.cell(first.toUpperCase());
    for (const [i, line] of lines.entries()) {
      const row = line.split('\t');
      if (origin.rowNumber() + i > 1048576 || origin.columnNumber() + row.length - 1 > 16384) throw Error('Data exceeds the worksheet dimensions.');
      for (const [j, value] of row.entries()) {
        if (value.length > 32767) throw Error('Excel cell text is longer than 32767 characters.');
        sheet.cell(origin.rowNumber() + i, origin.columnNumber() + j).value(value);
      }
    }
    return book.outputAsync();
  }
  if (input) {
    if (!data.find) throw Error('Give the unique text to replace.');
    return replaceRun(input, ext, data.find, data.content);
  }
  if (ext === '.docx') {
    return Packer.toBuffer(new Document({ sections: [{ children: lines.map(text => new Paragraph(text)) }] }));
  }
  if (ext !== '.pptx') throw Error('Unsupported Office extension.');
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  const slides = lines.join('\n').split(/^---\s*$/m);
  for (const section of slides) {
    const [title, ...body] = section.trim().split('\n');
    const slide = deck.addSlide();
    slide.addText(title, { x: 0.65, y: 0.45, w: 12, h: 1.1, fontSize: 34, bold: true, fit: 'shrink' });
    slide.addText(body.join('\n'), { x: 0.65, y: 1.65, w: 12, h: 5.35, fontSize: 22, valign: 'top', fit: 'shrink' });
  }
  return Buffer.from(await deck.write({ outputType: 'nodebuffer', compression: true }) as Uint8Array);
}

async function main() {
  const [ext, output, source] = process.argv.slice(2);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  fs.writeFileSync(output, await generate(ext, data, source ? fs.readFileSync(source) : undefined), { flag: 'wx' });
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
