/** Words of a phrase, lower-cased, without punctuation. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
}

/**
 * True when what the microphone heard is mostly Jarvin's own recent speech coming back through the speakers.
 * A real interruption has words that were not just said (for example "stop" or a new request).
 */
export function isEchoOfOwnSpeech(heard: string, recentlySpoken: string): boolean {
  const h = words(heard);
  if (h.length < 3) return false;
  const spoken = new Set(words(recentlySpoken));
  if (!spoken.size) return false;
  const matched = h.filter((w) => spoken.has(w)).length;
  return matched / h.length >= 0.8;
}
