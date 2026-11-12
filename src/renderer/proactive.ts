import type { JarvinApi, Settings } from '../shared/types';
import type { Reminder } from '../shared/reminders';
import { batteryStep, delivery, proactiveSettings } from '../shared/proactive';

/** Opt-in notices: low battery and due reminders. Always a toast; spoken unless it is quiet hours, Jarvin is already talking, or the hourly limit is reached. */
export function initProactive(d: { jarvin: JarvinApi; getSettings: () => Settings; say(text: string): void; toast(text: string): void; isSpeaking(): boolean }) {
  let spoken: number[] = [];
  let warned = false;
  const announced = new Set<string>();
  const meetings = new Set<string>();
  let readSequence = 0;
  const conf = () => proactiveSettings(d.getSettings().proactive);

  function notice(text: string) {
    const r = delivery(conf(), new Date(), spoken, d.isSpeaking());
    spoken = r.history;
    d.toast(text);
    if (r.speak) d.say(text);
  }

  async function reminders() {
    const sequence = ++readSequence;
    let records: Reminder[];
    try { records = await d.jarvin.remindersList(); } catch { return; }
    if (sequence !== readSequence) return;
    const s = conf();
    const due = records.filter(r => r.state === 'due');
    const dueIds = new Set(due.map((r) => r.id));
    for (const id of announced) if (!dueIds.has(id)) announced.delete(id); // snoozed or dismissed: may be announced again later
    for (const r of due) {
      if (announced.has(r.id)) continue;
      announced.add(r.id);
      if (s.enabled && s.speakReminders) notice(`Reminder: ${r.text}`);
    }
    const current = new Set<string>();
    const now = Date.now();
    for (const r of records) {
      const left = r.dueAt - now;
      if (r.state !== 'pending' || left <= 0 || left > 600_000 || !/\bmeeting\b/i.test(r.text)) continue;
      const key = `${r.id}/${r.dueAt}`;
      current.add(key);
      if (s.enabled && s.meetings && !meetings.has(key)) {
        meetings.add(key);
        notice(`In ${Math.ceil(left / 60_000)} min: ${r.text}`);
      }
    }
    for (const key of meetings) if (!current.has(key)) meetings.delete(key);
  }

  async function battery() {
    const nav = globalThis.navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(type: string, cb: () => void): void }> };
    if (!nav?.getBattery) return;
    try {
      const b = await nav.getBattery();
      const check = () => {
        const step = batteryStep(warned, b.level, b.charging);
        warned = step.warned;
        const s = conf();
        if (step.warn && s.enabled && s.lowBattery) notice(`Battery is at ${Math.round(b.level * 100)} percent. Plug in the charger soon.`);
      };
      b.addEventListener('levelchange', check);
      b.addEventListener('chargingchange', check);
      check();
    } catch { /* no battery information on this PC */ }
  }

  d.jarvin.onReminders(() => void reminders());
  d.jarvin.onModelProgress(p => {
    const s = conf();
    if (s.enabled && s.downloads && p.done && !p.error) notice(`Model download finished: ${p.name}`);
  });
  d.jarvin.onCommandFinished(status => {
    const s = conf();
    if (s.enabled && s.commands) notice(status === 'done' ? 'Background command finished.' : 'Background command failed. Open Tasks for details.');
  });
  window.setInterval(() => { if (conf().enabled && conf().meetings) void reminders(); }, 30_000);
  void reminders();
  void battery();
}
