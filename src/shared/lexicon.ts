/** Personal dictionary (word fixes) and snippets (say a phrase, get a block of text). Pure, shared by main, renderer and tests. */

export interface DictEntry { from: string; to: string }
export interface Snippet { trigger: string; text: string }

const MAX_ENTRIES = 300;
const MAX_TEXT = 4000;

function lines(src: string): string[] {
  return String(src ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** One entry per line: `heard => written`, or just `Written` to fix its capitalisation (`kubernetes` -> `Kubernetes`). */
export function parseDictionary(src: string): DictEntry[] {
  const out: DictEntry[] = [];
  for (const l of lines(src)) {
    const i = l.indexOf('=>');
    const from = (i >= 0 ? l.slice(0, i) : l).trim();
    const to = (i >= 0 ? l.slice(i + 2) : l).trim();
    if (!from || !to || from.length > 80 || to.length > 200) continue;
    out.push({ from, to });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** One snippet per line: `trigger phrase => text`. Write `\n` inside the text for a line break. */
export function parseSnippets(src: string): Snippet[] {
  const out: Snippet[] = [];
  for (const l of lines(src)) {
    const i = l.indexOf('=>');
    if (i < 0) continue;
    const trigger = l.slice(0, i).trim();
    const text = l.slice(i + 2).trim().replace(/\\n/g, '\n').slice(0, MAX_TEXT);
    if (trigger.length < 3 || trigger.length > 80 || !text) continue;
    out.push({ trigger, text });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches the phrase whole-word, case-insensitive, tolerating spaces and light punctuation between its words. */
function phraseRe(phrase: string): RegExp {
  const words = phrase.split(/\s+/).filter(Boolean).map(esc);
  return new RegExp(`(?<![\\w@])${words.join('[\\s,.;:!?-]+')}(?![\\w])`, 'gi');
}

/** Replace what the speech engine heard with what you want written. Longest phrases win. */
export function applyDictionary(text: string, entries: DictEntry[]): string {
  let out = text;
  for (const e of [...entries].sort((a, b) => b.from.length - a.from.length)) out = out.replace(phraseRe(e.from), () => e.to);
  return out;
}

/** Words to tell the cleanup model to keep exactly as written. */
export function dictionaryTerms(entries: DictEntry[]): string[] {
  return [...new Set(entries.map((e) => e.to))].slice(0, 60);
}

const TOKEN = (i: number) => `QQSNIP${i}QQ`;

/**
 * Swap snippet triggers for placeholders before AI cleanup, so the model cannot reword the expansion.
 * Restore afterwards with restoreSnippets.
 */
export function protectSnippets(text: string, snippets: Snippet[]): { text: string; map: string[] } {
  const map: string[] = [];
  let out = text;
  for (const s of [...snippets].sort((a, b) => b.trigger.length - a.trigger.length)) {
    out = out.replace(phraseRe(s.trigger), () => {
      map.push(s.text);
      return TOKEN(map.length - 1);
    });
  }
  return { text: out, map };
}

/** Put the expansions back. Returns null when cleanup lost a placeholder, so the caller can fall back. */
export function restoreSnippets(text: string, map: string[]): string | null {
  if (!map.length) return text;
  for (let i = 0; i < map.length; i++) if (!new RegExp(TOKEN(i), 'i').test(text)) return null;
  return text.replace(/QQSNIP(\d+)QQ/gi, (_m, n) => map[Number(n)] ?? '');
}
