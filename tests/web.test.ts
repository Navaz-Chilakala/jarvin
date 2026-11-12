import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchWebPage, htmlToText, parseSearchResults, readWebText, researchWeb } from '../src/main/web';

test('web response reader bounds streamed data and preserves split UTF-8 characters', async () => {
  const bytes = new TextEncoder().encode('A€BC');
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.enqueue(bytes.subarray(2));
      controller.close();
    },
  }));
  assert.deepEqual(await readWebText(response, 5), { text: 'A€B', truncated: true });
  assert.deepEqual(await readWebText(new Response('hello'), 5), { text: 'hello', truncated: false });
});

test('HTML extraction removes script content and decodes numeric entities', () => {
  assert.equal(htmlToText('<h1>Info</h1><script>ignore me</script><p>Price &#x20b9;10<br>Next &amp; more</p>'), 'Info\n Price ₹10\nNext & more');
});

test('fetching follows a redirect, reports its source, and rejects binary and failed pages', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/page' }); res.end(); }
    else if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<p>Documentation</p>'); }
    else if (req.url === '/pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end('%PDF-1.4'); }
    else { res.writeHead(404); res.end('missing'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signal = new AbortController().signal;
  try {
    const page = await fetchWebPage(`${base}/redirect`, signal);
    assert.match(page, new RegExp(`Source: ${base}/page`));
    assert.match(page, /Documentation/);
    await assert.rejects(fetchWebPage(`${base}/pdf`, signal), /application\/pdf/);
    await assert.rejects(fetchWebPage(`${base}/missing`, signal), /HTTP 404/);
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
});

test('fetching labels a long page as truncated and respects cancellation', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('a'.repeat(20_000));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.match(await fetchWebPage(`${base}/long`, new AbortController().signal), /Page truncated/);
    const controller = new AbortController();
    const fetching = fetchWebPage(`${base}/hang`, controller.signal);
    controller.abort();
    await assert.rejects(fetching);
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
});

test('search results preserve direct source links and skip invalid or duplicate addresses', () => {
  const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&amp;x=1">Official &amp; docs</a>' +
    '<a class="result__snippet">A <b>useful</b> page</a>' +
    '<a class="result__a" href="https://example.org/a">Duplicate</a>' +
    '<a class="result__a" href="javascript:alert(1)">Unsafe</a>';
  assert.deepEqual(parseSearchResults(html), [{ title: 'Official & docs', url: 'https://example.org/a', snippet: 'A useful page' }]);
});

test('research collects multiple sources, limits excerpts, and reports failures', async () => {
  const fetched: string[] = [];
  const signal = new AbortController().signal;
  const results = [1, 2, 3, 4].map((n) => ({ title: `Source ${n}`, url: `https://example.org/${n}`, snippet: '' }));
  const output = await researchWeb('question', signal, {
    search: async () => results,
    fetchPage: async (url) => {
      fetched.push(url);
      if (url.endsWith('/2')) throw new Error('HTTP 403');
      return `Source: ${url}\n${'x'.repeat(6_000)}`;
    },
  });
  assert.equal(fetched.length, 3);
  assert.match(output, /\[1\] Source 1/);
  assert.match(output, /Source excerpt truncated/);
  assert.match(output, /Could not read this source: HTTP 403/);
  assert.doesNotMatch(output, /Source 4/);
});

test('research returns no-source and cancellation results without inventing pages', async () => {
  const controller = new AbortController();
  assert.match(await researchWeb('nothing', controller.signal, { search: async () => [] }), /no sources could be read/i);
  const fetching = researchWeb('question', controller.signal, {
    search: async () => [{ title: 'Page', url: 'https://example.org/', snippet: '' }],
    fetchPage: async () => { controller.abort(); throw new Error('cancelled'); },
  });
  await assert.rejects(fetching, /cancelled/);
});
