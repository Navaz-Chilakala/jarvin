export type RunState = 'running' | 'finished' | 'failed' | 'stopped' | 'paused' | 'interrupted';
export interface RunToolRecord {
  id: string;
  name: string;
  state: 'requested' | 'reported' | 'failed';
}
export interface RunRecord {
  id: string;
  state: RunState;
  request: string;
  requestTruncated: boolean;
  workspace: string;
  sessionId: string;
  model: string;
  hadImages: boolean;
  activePath?: string;
  startedAt: number;
  updatedAt: number;
  tools: RunToolRecord[];
}

const RESUME_PREFIX = 'Review this interrupted request before taking action.';
/** A crash older than this is left for manual review: the screen and files have likely moved on. */
export const RESUME_WINDOW_MS = 30 * 60_000;

/** The request sent when an interrupted run is continued: the original text plus what was recorded, never a replay of tool calls. */
export function resumeRequest(run: RunRecord): string {
  const activity = run.tools.slice(-10).map((tool) => `- ${tool.name}: ${tool.state === 'requested' ? 'outcome unknown' : tool.state === 'failed' ? 'reported failure' : 'result reported; verify effect'}`).join('\n');
  const notes = [run.activePath ? `Previously active file: ${run.activePath}` : '', run.hadImages ? 'Previous images must be reattached.' : '', run.requestTruncated ? 'The saved request is incomplete.' : '', activity ? `Recorded tool activity (names only):\n${activity}` : 'No tool activity was recorded.'].filter(Boolean).join('\n');
  return `${RESUME_PREFIX} Check what has already happened and avoid repeating completed actions without asking.\n\nOriginal request:\n${run.request}${notes ? `\n\n${notes}` : ''}`;
}

/**
 * The one run that may continue by itself after a restart, or null. Only the newest record is considered, and only if it
 * was cut off by a crash or exit (not paused by the user), is recent, is complete, and is not itself a resumed run
 * (so a task that crashes the app is retried once, not in a loop).
 */
export function pickResumable(runs: RunRecord[], now: number): RunRecord | null {
  const run = [...runs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!run || run.state !== 'interrupted' || now - run.updatedAt > RESUME_WINDOW_MS) return null;
  if (run.hadImages || run.requestTruncated || run.request.startsWith(RESUME_PREFIX)) return null;
  return run;
}
