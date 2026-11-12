import { execFile } from 'node:child_process';
import type { Reminder } from '../shared/reminders';

/** Task names are built only from a UUID, so nothing user-written reaches PowerShell as code. */
const taskName = (id: string) => `JarvinReminder_${id.replace(/[^A-Za-z0-9-]/g, '')}`;
const encode = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

/** What the Windows scheduled task runs when it fires: a pop-up with the reminder text (passed as base64, never as code). */
export function popupScript(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `Add-Type -AssemblyName System.Windows.Forms; $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); [void][System.Windows.Forms.MessageBox]::Show($t, 'Jarvin reminder', 'OK', 'Information')`;
}

/** PowerShell that registers a one-time task for the current user. It fires 90 s after the due time, so Jarvin (which cancels it) wins when it is open. */
export function createScript(r: Pick<Reminder, 'id' | 'text' | 'dueAt'>): string {
  if (!Number.isFinite(r.dueAt)) throw new Error('Invalid due time.');
  const arg = `-NoProfile -WindowStyle Hidden -EncodedCommand ${encode(popupScript(r.text))}`;
  return [
    `$at = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.trunc(r.dueAt)}).LocalDateTime.AddSeconds(90)`,
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '${arg}'`,
    `$trigger = New-ScheduledTaskTrigger -Once -At $at`,
    `$trigger.EndBoundary = $at.AddHours(2).ToString('s')`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 10)`,
    `Register-ScheduledTask -TaskName '${taskName(r.id)}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join('; ');
}

export function cancelScript(id: string): string {
  return `Unregister-ScheduledTask -TaskName '${taskName(id)}' -Confirm:$false -ErrorAction SilentlyContinue`;
}

const pending = new Map<string, Promise<void>>();
function run(id: string, script: string): void {
  if (process.platform !== 'win32') return;
  const task = (pending.get(id) ?? Promise.resolve()).then(() => new Promise<void>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encode(script)], { windowsHide: true, timeout: 15000 }, () => resolve());
  })).catch(() => {});
  pending.set(id, task);
  void task.then(() => { if (pending.get(id) === task) pending.delete(id); });
}

/** Lets reminders still appear when Jarvin has been closed. Best effort: failures are ignored. */
export const windowsReminderBackup = {
  create: (r: Reminder) => { try { run(r.id, createScript(r)); } catch { /* best effort */ } },
  cancel: (id: string) => { try { run(id, cancelScript(id)); } catch { /* best effort */ } },
};
