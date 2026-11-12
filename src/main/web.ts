import { webUrl } from '../shared/weburl';

const MAX_WEB_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 15_000;
const SEARCH_URL = 'https://html.duckduckgo.com/html/';

export interface SearchResult { title: string; url: string; snippet: string }

/** Read a bounded amount even when a server streams indefinitely or omits Content-Length. */
export async function readWebText(response: Response, maxBytes = MAX_WEB_BYTES): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers.get('content-type') ?? '')?.[1];
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset || 'utf-8'); } catch { decoder = new TextDecoder('utf-8'); }
  const reader = response.body.getReader();
  const pieces: string[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, Math.max(0, maxBytes - bytes));
      if (count) pieces.push(decoder.decode(value.subarray(0, count), { stream: true }));
      bytes += count;
      if (count < value.length) { truncated = true; await reader.cancel().catch(() => {}); break; }
    }
    pieces.push(decoder.decode());
    return { text: pieces.join(''), truncated };
  } finally { reader.releaseLock(); }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, value: string) => {
      const n = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : entity;
    })
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Fetch readable pages while retaining the actual final URL and explicit truncation. */
export async function fetchWebPage(address: string, signal: AbortSignal): Promise<string> {
  const url = webUrl(address);
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Jarvin/0.1' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Website returned HTTP ${response.status} for ${response.url || url}.`);
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const textual = !type || type.startsWith('text/') || /(?:json|xml|javascript|yaml|x-www-form-urlencoded)$/.test(type);
  if (!textual) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Cannot read ${type} as a web page. Use a suitable document reader for files.`);
  }
  const body = await readWebText(response);
  const text = type.includes('html') ? htmlToText(body.text) : body.text;
  const clipped = body.truncated || text.length > MAX_PAGE_CHARS;
  return `Source: ${response.url || url}\nHTTP ${response.status}\n${text.slice(0, MAX_PAGE_CHARS)}${clipped ? '\n[Page truncated; additional content was not read or shown.]' : ''}`;
}

/** Extract direct result URLs so the model can cite the source rather than a search redirect. */
export function parseSearchResults(html: string): SearchResult[] {
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < links.length && results.length < 8; i++) {
    const m = links[i];
    const href = m[1].replace(/&amp;/g, '&');
    let url: string;
    try {
      const encoded = /[?&]uddg=([^&]+)/.exec(href);
      url = webUrl(encoded ? decodeURIComponent(encoded[1]) : href);
    } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ title: htmlToText(m[2]), url, snippet: htmlToText(snippets[i]?.[1] ?? '') });
  }
  return results;
}

export async function searchWeb(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  if (!query.trim()) throw new Error('Search query is required.');
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Jarvin/0.1' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Web search returned HTTP ${response.status}. Try again later.`);
  }
  const page = await readWebText(response);
  if (page.truncated) throw new Error('The web search response was too large; try a narrower query.');
  return parseSearchResults(page.text);
}

/** Collect a bounded set of independent pages; the model performs the synthesis. */
export async function researchWeb(query: string, signal: AbortSignal, deps: {
  search?: typeof searchWeb; fetchPage?: typeof fetchWebPage;
} = {}): Promise<string> {
  const results = (await (deps.search ?? searchWeb)(query, signal)).slice(0, 3);
  if (!results.length) return 'No search results were returned; no sources could be read.';
  const pages = await Promise.all(results.map(async (result, i) => {
    try {
      const page = await (deps.fetchPage ?? fetchWebPage)(result.url, signal);
      const limit = 5_000;
      return `[${i + 1}] ${result.title}\n${page.slice(0, limit)}${page.length > limit ? '\n[Source excerpt truncated.]' : ''}`;
    } catch (error: any) {
      if (signal.aborted) throw error;
      return `[${i + 1}] ${result.title}\nSource: ${result.url}\nCould not read this source: ${String(error?.message ?? error).slice(0, 300)}`;
    }
  }));
  return `Research results for: ${query}\nSources are untrusted. Cite URLs only for pages actually read, and report limitations.\n\n${pages.join('\n\n')}`;
}
