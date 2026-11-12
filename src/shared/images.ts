// Image files Jarvin can show, and which markdown image paths count as "a file in the project".

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
};

export const extOf = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p.split(/[?#]/)[0])?.[1] ?? '').toLowerCase();
export const imageMime = (p: string): string | undefined => MIME[extOf(p)];
export const isImagePath = (p: string) => !!imageMime(p);

/**
 * A markdown image address that points inside the project: relative, no scheme, no "..", no drive letter.
 * Returns the cleaned path with forward slashes, or null for anything else (web images are never loaded).
 */
export function workspaceImageRef(src: string): string | null {
  const s = src.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (!s || s.length > 400 || /[\u0000-\u001f<>"&]/.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('/') || s.startsWith('//')) return null;
  if (s.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return isImagePath(s) ? s : null;
}

export function dataUrl(mime: string, bytes: Uint8Array | Buffer): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}
