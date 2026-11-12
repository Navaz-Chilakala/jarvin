/** Small unified diff for showing a change before it is applied. Line based; files too large to compare are summarised. */
export function unifiedDiff(a: string | null, b: string | null, name: string, context = 3): string {
  const A = a === null ? [] : a.replace(/\r\n/g, '\n').split('\n');
  const B = b === null ? [] : b.replace(/\r\n/g, '\n').split('\n');
  const head = `--- ${a === null ? '/dev/null' : 'a/' + name}\n+++ ${b === null ? '/dev/null' : 'b/' + name}\n`;
  if (a !== null && b !== null && a === b) return '';
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length;
  let eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - s;
  const m = eb - s;
  if (n * m > 4_000_000) return `${head}@@ file too large to compare line by line (${A.length} → ${B.length} lines) @@\n`;
  // LCS table over the differing middle only.
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i * w + j] = A[s + i] === B[s + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  type Op = { k: ' ' | '-' | '+'; text: string };
  const ops: Op[] = [];
  for (let i = 0; i < s; i++) ops.push({ k: ' ', text: A[i] });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[s + i] === B[s + j]) {
      ops.push({ k: ' ', text: A[s + i] });
      i++;
      j++;
    } else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) ops.push({ k: '-', text: A[s + i++] });
    else ops.push({ k: '+', text: B[s + j++] });
  }
  for (let x = ea; x < A.length; x++) ops.push({ k: ' ', text: A[x] });
  const out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].k === ' ') {
      k++;
      continue;
    }
    const from = Math.max(0, k - context);
    let to = k;
    let lastChange = k;
    while (to < ops.length && to - lastChange <= context * 2 + 1) {
      if (ops[to].k !== ' ') lastChange = to;
      to++;
    }
    to = Math.min(ops.length, lastChange + context + 1);
    let oa = 1;
    let ob = 1;
    for (let x = 0; x < from; x++) {
      if (ops[x].k !== '+') oa++;
      if (ops[x].k !== '-') ob++;
    }
    let la = 0;
    let lb = 0;
    const body: string[] = [];
    for (let x = from; x < to; x++) {
      body.push(ops[x].k + ops[x].text);
      if (ops[x].k !== '+') la++;
      if (ops[x].k !== '-') lb++;
    }
    out.push(`@@ -${la === 0 ? oa - 1 : oa},${la} +${lb === 0 ? ob - 1 : ob},${lb} @@`, ...body);
    k = to;
  }
  return head + out.join('\n') + '\n';
}
