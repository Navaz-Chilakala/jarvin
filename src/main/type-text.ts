import { clipboard } from 'electron';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Types text exactly by putting it on the clipboard and pressing Ctrl+V, then restoring the clipboard.
 * Key-by-key typing dropped letters in some apps; a paste cannot. Falls back to typing if the paste keystroke fails.
 */
export async function typeText(
  send: (kind: 'key' | 'text', value: string) => Promise<string>,
  text: string,
): Promise<string> {
  if (text.length < 2) return send('text', text);
  const prevText = clipboard.readText();
  const prevImage = clipboard.readImage();
  clipboard.writeText(text);
  try {
    const result = await send('key', '^v');
    await sleep(400);
    return result;
  } catch {
    return send('text', text);
  } finally {
    try {
      if (clipboard.readText() === text) {
        if (!prevImage.isEmpty() && !prevText) clipboard.writeImage(prevImage);
        else clipboard.writeText(prevText);
      }
    } catch { /* best effort */ }
  }
}
