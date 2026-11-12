import { clipboard } from 'electron';
import { execFile } from 'node:child_process';

export interface PasteResult {
  ok: boolean;
  /** true when the text was only placed on the clipboard (not Windows, or the paste keystroke failed) */
  copied?: boolean;
  error?: string;
}

/** PowerShell one-liner that presses Ctrl+V in whichever window has focus. */
export const PASTE_COMMAND = "(New-Object -ComObject WScript.Shell).SendKeys('^v')";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Types `text` into the focused app by putting it on the clipboard and pressing Ctrl+V, then restores what was on the clipboard.
 * Only Windows can press the key; elsewhere the text stays on the clipboard so the user can paste it.
 */
export async function pasteIntoActiveApp(text: string, platform: string = process.platform): Promise<PasteResult> {
  if (!text) return { ok: true };
  const prevText = clipboard.readText();
  const prevImage = clipboard.readImage();
  clipboard.writeText(text);
  if (platform !== 'win32') return { ok: true, copied: true };
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PASTE_COMMAND], { windowsHide: true, timeout: 8000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  } catch (e: any) {
    return { ok: false, copied: true, error: `Could not press Ctrl+V (${String(e?.message ?? e).slice(0, 80)}). The text is on your clipboard.` };
  }
  await sleep(500);
  try {
    // Restore the clipboard only if nothing else replaced our text in the meantime.
    if (clipboard.readText() === text) {
      if (!prevImage.isEmpty() && !prevText) clipboard.writeImage(prevImage);
      else clipboard.writeText(prevText);
    }
  } catch {
    /* best effort */
  }
  return { ok: true };
}
