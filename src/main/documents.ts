import { execFile } from 'node:child_process';
import path from 'node:path';

/** Parse in a separate Node-mode process so malformed files cannot block the UI. */
export async function readDocument(
  kind: 'pdf' | 'docx' | 'ocr', file: string, signal: AbortSignal,
  options: { timeoutMs?: number; executable?: string; worker?: string; page?: number } = {},
): Promise<string> {
  const executable = options.executable ?? process.execPath;
  const worker = options.worker ?? path.join(__dirname, 'doc-worker.js');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(executable, [worker, kind, file, String(options.page ?? 1)], {
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
      signal,
      // Electron's executable runs this worker as Node, not as a second GUI app.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }, (error, output, stderr) => {
      if (error) return reject(new Error(signal.aborted ? 'Document reading cancelled.' : `Document reader failed: ${(stderr || error.message).slice(0, 1000)}`));
      resolve(output);
    });
  });
  let result: any;
  try { result = JSON.parse(stdout || '{}'); } catch { throw new Error('Document worker returned invalid output.'); }
  if (!result?.ok) throw new Error(String(result?.error ?? 'Document read failed.'));
  const content = String(result.text ?? '');
  return content + (content.trim() && result.pages ? `\n\n[${result.pages} pages]` : '');
}
