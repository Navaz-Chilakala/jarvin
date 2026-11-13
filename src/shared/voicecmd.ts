/** Voice commands, wake word and spoken-summary helpers. Pure functions, shared by renderer, main and tests. */

export type VoiceCommand =
  | { type: 'stop' }
  | { type: 'stopAll' }
  | { type: 'send' }
  | { type: 'clear' }
  | { type: 'newChat' }
  | { type: 'undo' }
  | { type: 'confirm' }
  | { type: 'approve'; risky: boolean }
  | { type: 'deny' }
  | { type: 'openFile'; name: string }
  | { type: 'closeTab' }
  | { type: 'nextTab' }
  | { type: 'prevTab' }
  | { type: 'openSettings' }
  | { type: 'closeSettings' }
  | { type: 'toggleSidebar' }
  | { type: 'scroll'; dir: 'up' | 'down'; amount?: number }
  | { type: 'scrollChat'; dir: 'up' | 'down' }
  | { type: 'focusInput' }
  /** "make this shorter": applied to the editor selection, else to the chat draft, else treated as plain dictation. */
  | { type: 'edit'; instruction: string };

export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const EXACT: Record<string, VoiceCommand> = {};
const add = (c: VoiceCommand, ...phrases: string[]) => phrases.forEach((p) => (EXACT[p] = c));
add({ type: 'stop' }, 'stop', 'stop that', 'stop it', 'cancel', 'cancel that', 'abort', 'be quiet', 'stop talking', 'stop speaking', 'quiet');
add({ type: 'stopAll' }, 'stop everything', 'stop all', 'stop all tasks', 'cancel everything', 'cancel all tasks');
add({ type: 'send' }, 'send', 'send it', 'send message', 'send that', 'submit');
add({ type: 'clear' }, 'clear', 'clear input', 'clear that', 'clear it', 'scratch that', 'delete that', 'clear the input');
add({ type: 'newChat' }, 'new chat', 'new conversation', 'start over', 'reset chat', 'start a new chat');
add({ type: 'undo' }, 'undo', 'undo that', 'undo it', 'undo last change', 'undo changes', 'undo the changes', 'revert that', 'undo the last change');
add({ type: 'confirm' }, 'confirm', 'confirm undo', 'yes confirm', 'confirm it');
add({ type: 'approve', risky: false }, 'approve', 'approve it', 'approve that', 'allow', 'allow it', 'allow that', 'yes approve', 'yes allow');
add({ type: 'approve', risky: true }, 'approve command', 'allow command', 'approve the command', 'allow the command', 'run it', 'run the command');
add({ type: 'deny' }, 'deny', 'deny it', 'deny that', 'reject', 'reject it', 'reject that', 'dont allow', 'do not allow', 'no deny', 'no dont');
add({ type: 'closeTab' }, 'close tab', 'close this tab', 'close file', 'close this file', 'close the tab');
add({ type: 'nextTab' }, 'next tab', 'next file');
add({ type: 'prevTab' }, 'previous tab', 'prev tab', 'last tab', 'previous file');
add({ type: 'openSettings' }, 'open settings', 'show settings', 'settings');
add({ type: 'closeSettings' }, 'close settings', 'hide settings');
add({ type: 'toggleSidebar' }, 'toggle sidebar', 'hide sidebar', 'show sidebar', 'toggle explorer', 'hide explorer', 'show explorer', 'toggle the sidebar');
add({ type: 'scroll', dir: 'up' }, 'scroll up', 'page up');
add({ type: 'scroll', dir: 'down' }, 'scroll down', 'page down');
add({ type: 'scrollChat', dir: 'up' }, 'scroll chat up', 'scroll the chat up', 'scroll jarvin up');
add({ type: 'scrollChat', dir: 'down' }, 'scroll chat down', 'scroll the chat down', 'scroll jarvin down');
add({ type: 'focusInput' }, 'focus chat', 'focus input', 'focus the chat', 'go to chat', 'type');

const EDIT_VERBS =
  'edit|change|rewrite|refactor|rename|fix|make|add|remove|delete|replace|convert|shorten|simplify|improve|optimi[sz]e|document|comment|explain|summari[sz]e|test|extract|move|format|clean up|translate|reword|expand|tidy';
const EDIT_RE = new RegExp(`^(?:${EDIT_VERBS})(?: up)? (?:this|that|it|the selection|the selected \\w+|selected \\w+|the above)\\b`);
const DRAFT_RE = /^(?:make it|make that|rewrite it|rewrite that|shorten it|shorten that|shorter|longer|more formal|more casual|more concise|more polite|translate (?:it|that) to \w+|fix the grammar|fix grammar|fix the spelling|add detail|expand it|simplify it)\b/;

/** Strip a leading polite word or the assistant's name. */
export function stripAddress(n: string): string {
  return n.replace(/^(?:(?:hey|hi|ok|okay) )?jarvi[ns](?:\s+|$)/, '').replace(/^(?:please|can you|could you) /, '').replace(/ please$/, '').trim();
}

export function parseVoiceCommand(text: string): VoiceCommand | null {
  const n = stripAddress(norm(text));
  if (!n) return null;
  const exact = EXACT[n];
  if (exact) return exact;
  const countScroll = /^scroll (up|down) (\d{1,3}|zero|one|two|three|four|five|six|seven|eight|nine|ten)(?: (?:step|steps|notch|notches))?$/.exec(n);
  if (countScroll) {
    const numbers: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    return { type: 'scroll', dir: countScroll[1] as 'up' | 'down', amount: numbers[countScroll[2]] ?? Number(countScroll[2]) };
  }
  const words = n.split(' ').length;
  const open = /^(?:open|go to|show me|switch to) (?:the )?(?:file )?(.+)$/.exec(n);
  // The renderer resolves the name against the workspace files; if nothing matches it is treated as plain dictation.
  if (open && words <= 6 && !/^(?:settings|sidebar|explorer|chat|input|tab|terminal)$/.test(open[1])) return { type: 'openFile', name: open[1] };
  if (words <= 14 && (EDIT_RE.test(n) || DRAFT_RE.test(n))) return { type: 'edit', instruction: text.trim() };
  return null;
}

/** Exact scroll commands go to the app in focus; explicit chat commands stay in Jarvin. */
export function scrollVoiceDestination(command: Extract<VoiceCommand, { type: 'scroll' | 'scrollChat' }>, jarvinFocused: boolean): 'chat' | 'desktop' {
  return command.type === 'scrollChat' || jarvinFocused ? 'chat' : 'desktop';
}

/* ---------------- wake word ---------------- */

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const WAKE = 'jarvin';
// Plausible mishearings only: starts like J/G/Y, ends in n or s (jarvin, jarvis, jervin, garvin), at most one letter off.
// Speech recognizers do not know the word "Jarvin" and write what it sounds like in the speaker's accent: Jarwin, Charvin,
// Darvin, Javin, Jarven, Jarbin. This pattern is the sound of the name: J-like start, "ar", V/W/F/B, a short vowel, N or S.
const SOUNDS_LIKE = /^(?:j|dj|g|y|ch|sh|d|z|zh)(?:a|aa|ah|e|o|u)r?(?:v|w|f|b|ph)(?:i|e|a|u|ee|ie|y)?(?:n|nn|ne|ns|nd|ng|m|s|ss)$/;
const isWakeWord = (w: string) => w.length >= 5 && w.length <= 8 && ((/^[jgy]/.test(w) && /[ns]$/.test(w) && lev(w, WAKE) <= 1) || SOUNDS_LIKE.test(w));
// The name is also often split in two: "Jar vin, open Notepad".
const SPLIT = new Set(['jar vin', 'jar win', 'jar van', 'jar when', 'jar been', 'jar bin', 'jarv in', 'java in', 'ja vin', 'char vin', 'char win', 'jaw in', 'job in', 'joe vin', 'jo vin', 'jar wind', 'jar fin', 'jar ven']);
const isSplitWake = (a: string, b: string) => !!a && !!b && (SPLIT.has(`${a} ${b}`) || (a.length <= 4 && b.length <= 4 && isWakeWord(a + b)));

const LOOSE = new Set(['travis', 'harvis', 'harvin', 'gervis', 'gervais', 'charvis', 'jarvice', 'jarvas', 'jarvan', 'jarvin', 'jarvis', 'jervis', 'javis', 'jarves']);
const isLooseWake = (w: string) => LOOSE.has(w);
const FILLER = new Set(['um', 'uh', 'uhm', 'hmm', 'mm', 'oh', 'ah', 'so', 'and', 'well', 'okay', 'ok', 'now', 'the', 'a', 'you']);

/**
 * Looks for "hey jarvin" at the start of an utterance. Returns what follows it ('' when only the wake word was said),
 * or null when the utterance does not start with the wake word.
 */
export function matchWake(text: string): string | null {
  const tokens = text.trim().split(/\s+/);
  let i = 0;
  const first = norm(tokens[0] ?? '');
  if (/^(?:hey|hi|ok|okay|hello|yo)$/.test(first)) i = 1;
  const w = norm(tokens[i] ?? '');
  // After "hey" the speaker clearly means to address Jarvin, so accept more mishearings than for a bare word.
  if (!w || !(isWakeWord(w) || (i === 1 && isLooseWake(w)))) {
    // Whisper sometimes glues or splits it: "hey jarvin" -> "hejarvin", "hey jar vin".
    let glued = '';
    for (let k = 0; k < Math.min(3, tokens.length); k++) {
      glued += norm(tokens[k]);
      if (glued.length >= 8 && glued.length <= 11 && /[ns]$/.test(glued) && lev(glued, 'heyjarvin') <= 1)
        return tokens.slice(k + 1).join(' ').replace(/^[,.:;!?-]+\s*/, '').trim();
    }
    // The name split in two, with or without "hey" in front.
    if (isSplitWake(norm(tokens[i] ?? ''), norm(tokens[i + 1] ?? ''))) return tokens.slice(i + 2).join(' ').replace(/^[,.:;!?-]+\s*/, '').trim();
    // A filler or a scrap of background sound often lands in front of the name: "um Jarvin, open Notepad".
    for (let k = 1; k <= Math.min(2, tokens.length - 1); k++) {
      if (!FILLER.has(norm(tokens[k - 1]))) break;
      if (isWakeWord(norm(tokens[k]))) return tokens.slice(k + 1).join(' ').replace(/^[,.:;!?-]+\s*/, '').trim();
    }
    return null;
  }
  return tokens
    .slice(i + 1)
    .join(' ')
    .replace(/^[,.:;!?-]+\s*/, '')
    .trim();
}

/* ---------------- spoken replies ---------------- */

/** A short, speakable version of a markdown answer: no code, tables, URLs or markup; at most `max` characters of whole sentences. */
/** A whole utterance that only asks Jarvin to stop: "stop", "Jarvin, stop that", "cancel", "be quiet". Nothing longer counts. */
export function isStopPhrase(text: string): boolean {
  return /^(?:(?:hey[,\s]+)?jarvi[ns][,\s]+)?(?:please\s+)?(?:stop|cancel|abort|be quiet|quiet)(?:\s+(?:it|that|now|please|everything|all|talking|speaking))*[\s.!]*$/i.test(text.trim());
}

/**
 * The early look at an unfinished utterance uses a small, fast recognizer that mangles the name ("Hey Jarvin, stop"
 * comes out as "Hayds, Avin, stop."). So here a short utterance that ENDS in a stop word counts. Used only while
 * Jarvin is working or speaking, where stopping by mistake costs little and stopping late costs more.
 */
export function isEarlyStop(text: string): boolean {
  if (isStopPhrase(text)) return true;
  const words = text.toLowerCase().replace(/[^a-z' ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 5 && /^(?:stop|stopped|cancel|cancelled|canceled)$/.test(words[words.length - 1]);
}

export function speakable(markdown: string, max = 400): string {
  let t = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [t];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > max) break;
    out += s;
  }
  return (out || t.slice(0, max)).trim();
}

/* ---------------- voice approval policy ---------------- */

/** Tools a plain spoken "approve" may allow. Everything else (terminal commands, MCP tools, web fetches) needs the phrase "approve command". */
const VOICE_SAFE_TOOLS = new Set(['write_file', 'edit_file', 'web_search']);

export type VoiceApproval = 'allow' | 'needs-phrase';

/** Decide whether a spoken approve may allow this tool. Spoken "deny" is always fine and is not handled here. */
export function voiceApproval(cmd: { risky: boolean }, tool: string): VoiceApproval {
  return cmd.risky || VOICE_SAFE_TOOLS.has(tool) ? 'allow' : 'needs-phrase';
}
