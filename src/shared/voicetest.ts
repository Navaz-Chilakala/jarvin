import { matchWake } from './voicecmd';

/**
 * The voice test: the user reads these once, and every installed recognizer is scored on the recordings. The sentences
 * are the kind of thing said to Jarvin, avoid numbers (so "12" versus "twelve" is not counted as a mistake), and half
 * of them start with the wake phrase so the name is measured too.
 */
export const VOICE_TEST_SENTENCES: string[] = [
  'Hey Jarvin, open the calculator.',
  'Hey Jarvin, what time is it right now?',
  'Hey Jarvin, open Chrome and search for the weather today.',
  'Hey Jarvin, create a new note and save it on the desktop.',
  'Hey Jarvin, remind me to call the bank in the evening.',
  'Hey Jarvin, turn the volume down a little.',
  'Hey Jarvin, close this window and open my documents folder.',
  'Hey Jarvin, read the selected text and summarize it.',
  'Hey Jarvin, put Notepad on the left and Chrome on the right.',
  'Hey Jarvin, stop.',
  'Open the settings and switch to dark mode.',
  'Find my resume and open it in Word.',
  'Type a short message saying I will be late for the meeting.',
  'Take a look at the screen and tell me what the error means.',
  'Search the web for the best budget laptop this year.',
  'Create an Excel sheet with columns for item and price.',
  'Scroll down and click the blue download button.',
  'Minimize everything and show the desktop.',
  'Please lower the brightness and lock the screen.',
  'Cancel that and go back to the previous page.',
];

/** Lower case, no punctuation, single spaces: only the words are compared. */
export function testWords(text: string): string[] {
  return text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Word-level edit distance: how many words were wrong, missing or extra. */
export function wordErrors(expected: string, heard: string): { errors: number; words: number } {
  const a = testWords(expected), b = testWords(heard);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return { errors: prev[b.length], words: a.length };
}

export interface VoiceTestLine { index: number; expected: string; heard: string; errors: number; words: number; ms: number; nameExpected: boolean; nameHeard: boolean }
export interface VoiceTestModel {
  model: string;
  /** Set when the recognizer could not be loaded or run at all. */
  failed?: string;
  lines: VoiceTestLine[];
  errors: number; words: number;
  /** Percentage of words wrong; lower is better. */
  errorRate: number;
  exactSentences: number;
  nameHeard: number; nameExpected: number;
  avgMs: number;
}
export interface VoiceTestReport { at: number; clips: number; models: VoiceTestModel[] }

/** Scores one recognizer's transcripts. For name sentences the name itself is scored separately and left out of the word count. */
export function scoreModel(model: string, results: { index: number; heard: string; ms: number }[]): VoiceTestModel {
  const lines = results.map((r) => {
    const expected = VOICE_TEST_SENTENCES[r.index] ?? '';
    const nameExpected = matchWake(expected) !== null;
    const rest = matchWake(r.heard);
    const nameHeard = nameExpected && rest !== null;
    // Compare the request part only, so a misspelt name does not also count as wrong words.
    const want = nameExpected ? matchWake(expected) ?? expected : expected;
    const got = nameHeard ? rest ?? '' : nameExpected ? r.heard.split(/\s+/).slice(2).join(' ') : r.heard;
    const e = wordErrors(want, got);
    return { index: r.index, expected, heard: r.heard, errors: e.errors, words: e.words, ms: r.ms, nameExpected, nameHeard };
  });
  const errors = lines.reduce((n, l) => n + l.errors, 0), words = lines.reduce((n, l) => n + l.words, 0);
  return {
    model, lines, errors, words,
    errorRate: words ? Math.round((errors / words) * 1000) / 10 : 0,
    exactSentences: lines.filter((l) => l.errors === 0).length,
    nameHeard: lines.filter((l) => l.nameHeard).length,
    nameExpected: lines.filter((l) => l.nameExpected).length,
    avgMs: lines.length ? Math.round(lines.reduce((n, l) => n + l.ms, 0) / lines.length) : 0,
  };
}

/** Best first: fewest wrong words, then the name heard most often, then speed. Recognizers that failed go last. */
export function rankModels(models: VoiceTestModel[]): VoiceTestModel[] {
  return [...models].sort((a, b) => Number(!!a.failed) - Number(!!b.failed) || a.errorRate - b.errorRate || b.nameHeard - a.nameHeard || a.avgMs - b.avgMs);
}

export function shortModelName(model: string): string {
  return model === 'sherpa-onnx/qwen3-asr-0.6b-int8' ? 'Qwen3-ASR' : model.split('/').pop() ?? model;
}
