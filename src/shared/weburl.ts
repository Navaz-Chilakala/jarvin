/** Validate web addresses before passing them to the operating system or browser. */
export function webUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A website URL is required.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete URL beginning with http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Only HTTP or HTTPS URLs without embedded credentials are allowed.');
  }
  return url.href;
}
