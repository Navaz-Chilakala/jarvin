import { workspaceImageRef } from '../shared/images';
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

/* ---------------- syntax highlighting ---------------- */
type Fam = 'clike' | 'hash' | 'json' | 'markup' | 'css' | 'none';

const FAM: Record<string, Fam> = {};
const reg = (f: Fam, names: string) => names.split(' ').forEach((n) => (FAM[n] = f));
reg('clike', 'ts tsx js jsx mjs cjs javascript typescript java c h cpp hpp cc cs go rs rust kt swift php scala dart');
reg('hash', 'py python sh bash zsh shell yaml yml toml rb ruby dockerfile ini conf ps1 powershell makefile');
reg('json', 'json jsonc');
reg('markup', 'html htm xml svg vue');
reg('css', 'css scss less');

export const famFor = (nameOrLang: string): Fam => {
  const key = nameOrLang.toLowerCase();
  return FAM[key.includes('.') ? key.split('.').pop()! : key] ?? 'none';
};

const set = (s: string) => new Set(s.split(' '));
const KW_C = set(
  'abstract as async await break case catch class const continue default defer delete do else enum export extends false final finally fn for from func function go if impl implements import in instanceof interface let loop match mod mut namespace new nil null of override package private protected pub public readonly return self static struct super switch this throw throws true try type typeof undefined use using var void while with yield',
);
const KW_H = set(
  'and as assert async await break case class continue def del do done elif else end esac except export false fi finally for from function global if import in is lambda local nonlocal not null or pass raise return self source then true try unless until while with yield echo cd None True False',
);

function run(text: string, re: RegExp, cls: (m: RegExpMatchArray) => string | null): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out += esc(text.slice(last, at));
    const c = cls(m);
    out += c ? `<span class="${c}">${esc(m[0])}</span>` : esc(m[0]);
    last = at + m[0].length;
  }
  return out + esc(text.slice(last));
}

const RE_C = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?)|(\b0x[\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=(\s*\())?/g;
const RE_H = /(#[^\n]*)|("(?:\\.|[^"\\\n])*"?|'[^'\n]*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w]*)(?=(\s*\())?/g;
const RE_M = /(<!--[\s\S]*?(?:-->|$))|(<\/?[A-Za-z][\w:-]*|\/?>)|("[^"]*"|'[^']*')/g;
const RE_CSS = /(\/\*[\s\S]*?(?:\*\/|$))|("[^"\n]*"|'[^'\n]*')|(#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg)?\b)|(@[\w-]+)|([\w-]+)(?=\s*:)/g;
const RE_J = /("(?:\\.|[^"\\\n])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;

export function highlight(code: string, lang: string): string {
  switch (famFor(lang)) {
    case 'clike':
      return run(code, RE_C, (m) => (m[1] ? 'cm' : m[2] ? 'str' : m[3] ? 'num' : KW_C.has(m[4]) ? 'kw' : m[5] !== undefined ? 'fn' : /^[A-Z]/.test(m[4]) ? 'ty' : null));
    case 'hash':
      return run(code, RE_H, (m) => (m[1] ? 'cm' : m[2] ? 'str' : m[3] ? 'num' : KW_H.has(m[4]) ? 'kw' : m[5] !== undefined ? 'fn' : /^[A-Z]/.test(m[4]) ? 'ty' : null));
    case 'markup':
      return run(code, RE_M, (m) => (m[1] ? 'cm' : m[2] ? 'tag' : 'str'));
    case 'css':
      return run(code, RE_CSS, (m) => (m[1] ? 'cm' : m[2] ? 'str' : m[3] ? 'num' : m[4] ? 'kw' : 'key'));
    case 'json': {
      let out = '';
      let last = 0;
      for (const m of code.matchAll(RE_J)) {
        const at = m.index ?? 0;
        out += esc(code.slice(last, at));
        if (m[1]) out += `<span class="${m[2] ? 'key' : 'str'}">${esc(m[1])}</span>${esc(m[2] ?? '')}`;
        else out += `<span class="${m[3] ? 'num' : 'kw'}">${esc(m[0])}</span>`;
        last = at + m[0].length;
      }
      return out + esc(code.slice(last));
    }
    default:
      return esc(code);
  }
}

/* ---------------- markdown ---------------- */
function inl(src: string): string {
  const codes: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s
    .replace(/!\[([^\]\n]*)\]\(([^\s)]+)\)/g, (_m, alt: string, src: string) => {
      const ref = workspaceImageRef(src);
      if (ref) return `<img class="chatimg" data-path="${ref}" alt="${alt}">`;
      return /^https?:\/\//i.test(src) ? `<a href="#" data-ext="${src}">image: ${alt || src}</a>` : `[image: ${alt}]`;
    })
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="#" data-ext="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)])}</code>`);
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isSep = (s: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s) && s.includes('-');
const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function blocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const starts = (i: number) =>
    /^#{1,6}\s/.test(lines[i]) ||
    /^\s*([-*_])\1{2,}\s*$/.test(lines[i]) ||
    /^\s*>/.test(lines[i]) ||
    LIST_RE.test(lines[i]) ||
    (lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1]));
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) {
      out.push(`<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`);
      i++;
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(l)) {
      out.push('<hr>');
      i++;
    } else if (l.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(
        `<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inl(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${inl(r[k] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
    } else if (/^\s*>/.test(l)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inl(q.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
    } else if (LIST_RE.test(l)) {
      const items: { indent: number; tag: string; text: string }[] = [];
      while (i < lines.length && lines[i].trim()) {
        const lm = LIST_RE.exec(lines[i]);
        if (lm) items.push({ indent: lm[1].replace(/\t/g, '  ').length, tag: /\d/.test(lm[2]) ? 'ol' : 'ul', text: lm[3] });
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1].text += ' ' + lines[i].trim();
        else break;
        i++;
      }
      let html = '';
      const stack: { indent: number; tag: string }[] = [];
      for (const it of items) {
        while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop()!.tag}>`;
        if (!stack.length || it.indent > stack[stack.length - 1].indent) {
          html += `<${it.tag}>`;
          stack.push({ indent: it.indent, tag: it.tag });
        } else html += '</li>';
        html += `<li>${inl(it.text)}`;
      }
      while (stack.length) html += `</li></${stack.pop()!.tag}>`;
      out.push(html);
    } else {
      const par: string[] = [];
      while (i < lines.length && lines[i].trim() && (par.length === 0 || !starts(i))) par.push(lines[i++]);
      out.push(`<p>${inl(par.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('');
}

export function md(src: string): string {
  let html = '';
  let last = 0;
  for (const m of src.matchAll(/```([\w+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g)) {
    const at = m.index ?? 0;
    html += blocks(src.slice(last, at));
    const lang = m[1] || 'text';
    const body = m[2].replace(/\n$/, '');
    html += `<div class="code${lang.toLowerCase() === 'mermaid' ? ' mmd' : ''}"><div class="chead"><span>${esc(lang)}</span><button class="ccopy" type="button">Copy</button></div><pre><code>${highlight(body, lang)}</code></pre></div>`;
    last = at + m[0].length;
  }
  return html + blocks(src.slice(last));
}
