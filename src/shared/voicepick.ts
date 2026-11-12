export interface VoiceLike { name: string; lang: string; localService: boolean }

/** Scores a Windows speech voice: higher sounds more natural. Unknown voices get a low base score. */
export function voiceScore(v: VoiceLike): number {
  let s = /^en\b/i.test(v.lang) ? 100 : 0;
  if (/natural|neural/i.test(v.name)) s += 60;
  const known = ['aria', 'jenny', 'guy', 'sonia', 'ryan', 'zira', 'hazel', 'susan', 'mark', 'david'];
  const i = known.findIndex((n) => v.name.toLowerCase().includes(n));
  if (i >= 0) s += 40 - i * 3;
  return s;
}

/** Picks the saved voice if present, otherwise the most natural-sounding English local voice. */
export function pickVoice<T extends VoiceLike>(voices: T[], preferred = ''): T | undefined {
  const local = voices.filter((v) => v.localService);
  return local.find((v) => v.name === preferred) || [...local].sort((a, b) => voiceScore(b) - voiceScore(a))[0];
}
