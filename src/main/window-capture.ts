/** DesktopCapturer IDs contain the native window handle on Windows. Never fall back to another window. */
export function findWindowCapture<T extends { id: string }>(sources: T[], handle: string): T | undefined {
  if (!/^\d+$/.test(handle)) return undefined;
  const matches = sources.filter((source) => {
    const id = /^window:(\d+):\d+$/.exec(source.id);
    return !!id && id[1] === handle;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** A protected or occluded capture can be an opaque black bitmap even when it is not empty. */
export function isBlackCapture(bitmap: Uint8Array): boolean {
  if (bitmap.length < 4) return true;
  for (let i = 0; i + 3 < bitmap.length; i += 4) if (bitmap[i] > 8 || bitmap[i + 1] > 8 || bitmap[i + 2] > 8) return false;
  return true;
}
