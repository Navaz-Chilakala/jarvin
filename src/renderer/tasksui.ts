import type { JarvinApi } from '../shared/types';
import { clean, enqueue, fmtElapsed, moveInQueue, nextInQueue, shortText, type JobInfo, type QueueItem, type RunOutcome } from '../shared/jobs';
import { esc } from './markdown';
import type { RunRecord } from '../shared/run-journal';
import { repeatLabel, type Reminder } from '../shared/reminders';
import type { Routine } from '../shared/routines';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Messages waiting for the current run to end, and commands running in the background. */
export function createTasksUi(jarvin: JarvinApi, deps: { toast(m: string): void; openPreview(url: string): void; sendQueued(item: QueueItem): void; reviewRun(run: RunRecord): boolean; useRoutine(routine: Routine, runNow: boolean): boolean; runRoutineSteps(routine: Routine, scheduled: boolean): boolean }) {
  let queue: QueueItem[] = [];
  let paused = '';
  let jobs: JobInfo[] = [];
  let recovered: RunRecord[] = [];
  let reminders: Reminder[] = [];
  let routines: Routine[] = [];
  let routineError = '';
  let editingRoutine: Routine | null = null;
  let reminderError = '';
  let editingReminderId: string | null = null;
  let recoveryError = '';
  let selected = '';
  let tick: ReturnType<typeof setInterval> | undefined;
  const dlg = () => $<HTMLDialogElement>('tasksDlg');

  const running = () => jobs.filter((j) => j.status === 'running').length;

  function paintRoutines() {
    const box = $('tkRoutines');
    if (routineError) { box.textContent = `Routines unavailable: ${routineError}`; return; }
    if (!routines.length) { box.innerHTML = '<div class="hint">No saved routines yet.</div>'; return; }
    box.innerHTML = routines.map((r) => `<div class="tkrow" data-id="${esc(r.id)}"><span class="tktext"><strong>${esc(r.name)}</strong>${r.dailyAt ? `<span class="hint"> · every day at ${esc(r.dailyAt)}</span>` : ''}<ol>${r.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol></span><span class="tkbtns"><button type="button" class="btn small primary" data-a="run">Run</button><button type="button" class="btn small" data-a="steps" title="Each step runs as its own request. The queue shows what is left and pauses if a step fails.">Step by step</button><button type="button" class="btn small" data-a="review">Review</button><button type="button" class="btn small" data-a="edit">Edit</button><button type="button" class="btn small" data-a="remove">Delete</button></span></div>`).join('');
  }

  async function refreshRoutines() {
    try { routines = await jarvin.routinesList(); routineError = ''; }
    catch (e: any) { routineError = String(e?.message ?? e); }
    if (dlg().open) paintRoutines();
  }

  function clearRoutineEditor() {
    editingRoutine = null;
    $<HTMLInputElement>('tkRoutineName').value = '';
    $<HTMLTextAreaElement>('tkRoutineSteps').value = '';
    $<HTMLInputElement>('tkRoutineTime').value = '';
    $('tkRoutineEdit').textContent = '';
    $('tkRoutineCancel').hidden = true;
    $('tkRoutineSave').textContent = 'Save routine';
  }

  function chip() {
    const b = $<HTMLButtonElement>('taskChip');
    const parts: string[] = [];
    if (queue.length) parts.push(`${queue.length} queued`);
    if (running()) parts.push(`${running()} running`);
    if (recovered.length) parts.push(`${recovered.length} to review`);
    const due = reminders.filter((r) => r.state === 'due').length;
    if (due) parts.push(`${due} reminder${due === 1 ? '' : 's'}`);
    b.hidden = !parts.length;
    b.textContent = parts.join(' · ');
    b.classList.toggle('warn', (!!paused && queue.length > 0) || recovered.length > 0 || due > 0);
    b.title = paused && queue.length ? `Queue paused: ${paused}. Click to review.` : 'Tasks and interrupted requests';
  }

  function paintReminders() {
    const box = $('tkReminders');
    if (reminderError) { box.textContent = `Reminders unavailable: ${reminderError}`; return; }
    if (!reminders.length) { box.innerHTML = '<div class="hint">No reminders yet.</div>'; return; }
    box.innerHTML = reminders.map((r) => `<div class="tkrow" data-id="${esc(r.id)}"><span class="tkdot ${r.state === 'due' ? 'warn' : ''}"></span><span class="tktext"><strong>${esc(r.text)}</strong><span class="hint"> · ${r.state === 'due' ? 'due' : 'scheduled'} · ${esc(new Date(r.dueAt).toLocaleString())}${r.repeat ? ` · ${repeatLabel(r.repeat)}` : ''}</span></span><span class="tkbtns">${r.state === 'due' ? '<button type="button" class="btn small" data-a="snooze" data-min="10">Snooze 10 min</button><button type="button" class="btn small" data-a="snooze" data-min="60">1 hour</button>' : '<button type="button" class="btn small" data-a="edit">Edit</button>'}<button type="button" class="btn small" data-a="remove">${r.state === 'due' ? 'Dismiss' : 'Remove'}</button></span></div>`).join('');
  }

  async function refreshReminders() {
    try { reminders = await jarvin.remindersList(); reminderError = ''; }
    catch (e: any) { reminderError = String(e?.message ?? e); }
    chip();
    if (dlg().open) paintReminders();
  }

  function paintRecovered() {
    const box = $('tkRecovered');
    if (recoveryError) { box.textContent = `Task recovery unavailable: ${recoveryError}`; return; }
    if (!recovered.length) { box.innerHTML = '<div class="hint">No interrupted or paused requests in this folder.</div>'; return; }
    box.innerHTML = recovered.map((run) => {
      const last = run.tools.at(-1);
      const lastText = last ? `Last recorded tool: ${last.name} (${last.state}).` : 'No tool activity was recorded.';
      const extra = [run.hadImages ? 'Images must be reattached.' : '', run.requestTruncated ? 'The saved request was truncated.' : ''].filter(Boolean).join(' ');
      return `<div class="tkrow" data-id="${esc(run.id)}"><span class="tkdot warn"></span><span class="tktext"><strong>${esc(shortText(run.request, 100))}</strong><span class="hint"> · ${run.state === 'paused' ? 'paused' : 'interrupted'} · ${esc(new Date(run.startedAt).toLocaleString())}</span><div class="hint">${esc(lastText)} ${esc(extra)}</div></span><span class="tkbtns"><button type="button" class="btn small" data-a="review">Review</button><button type="button" class="btn small" data-a="dismiss">Remove</button></span></div>`;
    }).join('');
  }

  async function refreshRecovered() {
    try { recovered = await jarvin.interruptedRuns(); recoveryError = ''; }
    catch (e: any) { recovered = []; recoveryError = String(e?.message ?? e); }
    chip();
    if (dlg().open) paintRecovered();
  }

  function paintQueue() {
    const box = $('tkQueue');
    $('tkPaused').hidden = !(paused && queue.length);
    $('tkPaused').textContent = paused ? `Paused: ${paused}. The next message will not send by itself.` : '';
    $<HTMLButtonElement>('tkSendNext').hidden = !queue.length;
    $<HTMLButtonElement>('tkClearQ').hidden = !queue.length;
    if (!queue.length) { box.innerHTML = '<div class="hint">Nothing queued. Type while Jarvin is working and your message waits here, then runs on its own.</div>'; return; }
    box.innerHTML = queue.map((q, i) => `<div class="tkrow" data-id="${q.id}"><span class="tkn">${i + 1}</span><span class="tktext" title="${esc(q.text)}">${esc(shortText(q.text, 140))}${q.images?.length ? ` <span class="hint">+${q.images.length} image${q.images.length === 1 ? '' : 's'}</span>` : ''}</span><span class="tkbtns"><button type="button" class="btn small" data-a="up" ${i === 0 ? 'disabled' : ''}>&uarr;</button><button type="button" class="btn small" data-a="down" ${i === queue.length - 1 ? 'disabled' : ''}>&darr;</button><button type="button" class="btn small" data-a="rm">Remove</button></span></div>`).join('');
  }

  function paintJobs() {
    const box = $('tkJobs');
    $('tkClearJobs').hidden = !jobs.some((j) => j.status !== 'running');
    if (!jobs.length) { box.innerHTML = '<div class="hint">No background commands. Start one above, or ask Jarvin to start a dev server.</div>'; return; }
    const now = Date.now();
    box.innerHTML = jobs.map((j) => {
      const t = fmtElapsed((j.endedAt ?? now) - j.startedAt);
      const st = j.status === 'running' ? `running ${t}` : j.status === 'done' ? `finished in ${t}` : j.status === 'stopped' ? `stopped after ${t}` : `failed after ${t}${j.exitCode !== null ? ` (exit ${j.exitCode})` : ''}`;
      const cls = j.status === 'running' ? 'warn' : j.status === 'done' ? 'ok' : j.status === 'stopped' ? '' : 'bad';
      const url = j.urls[0] ? `<button type="button" class="btn small" data-a="prev" data-url="${esc(j.urls[0])}">Preview ${esc(j.urls[0].replace(/^https?:\/\//, '').replace(/\/$/, ''))}</button>` : '';
      return `<div class="tkrow job${j.id === selected ? ' sel' : ''}" data-id="${j.id}"><span class="tkdot ${cls}"></span><span class="tktext" title="${esc(j.command)}"><code>${esc(shortText(j.command, 90))}</code><span class="hint"> ${st}${j.byAgent ? ' · started by Jarvin' : ''}</span>${j.tail && j.id !== selected ? `<div class="tktail">${esc(shortText(j.tail.split('\n').pop() ?? '', 120))}</div>` : ''}</span><span class="tkbtns">${url}<button type="button" class="btn small" data-a="out">Output</button>${j.status === 'running' ? '<button type="button" class="btn small danger" data-a="stop">Stop</button>' : '<button type="button" class="btn small" data-a="rm">Remove</button>'}</span></div>`;
    }).join('');
  }

  async function paintOutput() {
    const pre = $('tkOut');
    if (!selected || !jobs.some((j) => j.id === selected)) { pre.hidden = true; selected = ''; return; }
    try {
      const r = await jarvin.jobsOutput(selected);
      const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
      pre.hidden = false;
      pre.textContent = clean(r.output).split('\n').slice(-400).join('\n') || '(no output yet)';
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    } catch {
      pre.hidden = true;
    }
  }

  function paintAll() { chip(); if (dlg().open) { paintRoutines(); paintReminders(); paintRecovered(); paintQueue(); paintJobs(); } }

  async function open() {
    jobs = await jarvin.jobsList().catch(() => jobs);
    await refreshRecovered();
    await refreshReminders();
    await refreshRoutines();
    dlg().showModal();
    paintAll();
    void paintOutput();
    clearInterval(tick);
    tick = setInterval(() => { if (!dlg().open) { clearInterval(tick); return; } paintJobs(); void paintOutput(); }, 1000);
  }

  function wire() {
    $('taskChip').onclick = () => void open();
    $('tasksBtn').onclick = () => void open();
    $('tkClose').onclick = () => dlg().close();
    void refreshRecovered();
    void refreshReminders();
    jarvin.onReminders(() => void refreshReminders());
    jarvin.onRoutineDue((routine) => { deps.runRoutineSteps(routine, true); void refreshRoutines(); });
    jarvin.onJobs((l) => { jobs = l; paintAll(); });
    void jarvin.jobsList().then((l) => { jobs = l; chip(); });
    $('tkRun').onclick = async () => {
      const inp = $<HTMLInputElement>('tkCmd');
      const cmd = inp.value.trim();
      if (!cmd) return;
      try {
        const j = await jarvin.jobsStart(cmd);
        inp.value = '';
        selected = j.id;
        jobs = await jarvin.jobsList();
        paintAll();
        void paintOutput();
      } catch (e: any) {
        deps.toast(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      }
    };
    $<HTMLInputElement>('tkCmd').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('tkRun').click(); } };
    $('tkClearJobs').onclick = () => void jarvin.jobsClear();
    $('tkRoutineCancel').onclick = clearRoutineEditor;
    $('tkRoutineSave').onclick = async () => {
      const name = $<HTMLInputElement>('tkRoutineName').value;
      const steps = $<HTMLTextAreaElement>('tkRoutineSteps').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      try {
        await jarvin.routinesSave(editingRoutine?.id ?? null, editingRoutine?.revision ?? null, name, steps, $<HTMLInputElement>('tkRoutineTime').value);
        clearRoutineEditor(); await refreshRoutines(); deps.toast('Routine saved.');
      } catch (error: any) { deps.toast(String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    };
    $('tkRoutines').onclick = async (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
      const id = button?.closest<HTMLElement>('.tkrow')?.dataset.id;
      const routine = routines.find((r) => r.id === id);
      if (!button || !routine) return;
      if (button.dataset.a === 'run' || button.dataset.a === 'review') {
        if (deps.useRoutine(routine, button.dataset.a === 'run')) dlg().close();
      } else if (button.dataset.a === 'steps') {
        if (deps.runRoutineSteps(routine, false)) dlg().close();
      } else if (button.dataset.a === 'edit') {
        editingRoutine = routine;
        $<HTMLInputElement>('tkRoutineTime').value = routine.dailyAt ?? '';
        $<HTMLInputElement>('tkRoutineName').value = routine.name;
        $<HTMLTextAreaElement>('tkRoutineSteps').value = routine.steps.join('\n');
        $('tkRoutineEdit').textContent = `Editing ${routine.name}`;
        $('tkRoutineCancel').hidden = false; $('tkRoutineSave').textContent = 'Save changes';
        $<HTMLInputElement>('tkRoutineName').focus();
      } else if (button.dataset.a === 'remove' && window.confirm(`Delete the routine "${routine.name}"?`)) {
        try { await jarvin.routinesRemove(routine.id, routine.revision); if (editingRoutine?.id === routine.id) clearRoutineEditor(); await refreshRoutines(); }
        catch (error: any) { deps.toast(String(error?.message ?? error)); }
      }
    };
    const text = $<HTMLInputElement>('tkReminderText');
    const when = $<HTMLInputElement>('tkReminderWhen');
    const repeat = $<HTMLSelectElement>('tkReminderRepeat');
    const save = $<HTMLButtonElement>('tkReminderAdd');
    function resetReminderEditor() {
      editingReminderId = null;
      text.value = ''; when.value = ''; repeat.value = 'once';
      save.textContent = 'Add reminder';
      $('tkReminderCancel').hidden = true;
    }
    $('tkReminderCancel').onclick = resetReminderEditor;
    save.onclick = async () => {
      save.disabled = true;
      try {
        const dueAt = new Date(when.value).getTime();
        if (editingReminderId) await jarvin.remindersUpdate(editingReminderId, text.value, dueAt, repeat.value);
        else await jarvin.remindersCreate(text.value, dueAt, repeat.value);
        resetReminderEditor();
        await refreshReminders();
        deps.toast('Reminder saved.');
      } catch (error: any) { deps.toast(String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
      finally { save.disabled = false; }
    };
    $('tkReminders').onclick = async (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
      const id = button?.closest<HTMLElement>('.tkrow')?.dataset.id;
      const record = reminders.find(r => r.id === id);
      if (!button || !record) return;
      if (button.dataset.a === 'edit') {
        editingReminderId = record.id;
        text.value = record.text;
        const date = new Date(record.dueAt);
        when.value = new Date(record.dueAt - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        repeat.value = record.repeat ?? 'once';
        save.textContent = 'Save changes';
        $('tkReminderCancel').hidden = false;
        text.focus();
        return;
      }
      try {
        if (button.dataset.a === 'snooze') await jarvin.remindersSnooze(record.id, Number(button.dataset.min));
        else if (button.dataset.a === 'remove') await jarvin.remindersRemove(record.id);
        if (editingReminderId === record.id) resetReminderEditor();
        await refreshReminders();
      }
      catch (error: any) { deps.toast(String(error?.message ?? error)); }
    };
    $('tkClearRuns').onclick = async () => {
      if (!window.confirm('Remove finished, failed and stopped task records for this folder? Interrupted and paused requests are kept.')) return;
      try { const count = await jarvin.clearFinishedRuns(); deps.toast(`Removed ${count} finished task record${count === 1 ? '' : 's'}.`); }
      catch (e: any) { deps.toast(String(e?.message ?? e)); }
    };
    $('tkClearQ').onclick = () => { queue = []; paused = ''; paintAll(); };
    $('tkSendNext').onclick = () => {
      const r = nextInQueue(queue, 'done');
      if (!r.item) return;
      queue = r.rest; paused = ''; paintAll();
      dlg().close();
      deps.sendQueued(r.item);
    };
    $('tkQueue').onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
      const id = b?.closest<HTMLElement>('.tkrow')?.dataset.id;
      if (!b || !id) return;
      if (b.dataset.a === 'rm') queue = queue.filter((q) => q.id !== id);
      else queue = moveInQueue(queue, id, b.dataset.a === 'up' ? -1 : 1);
      paintAll();
    };
    $('tkJobs').onclick = async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
      const id = b?.closest<HTMLElement>('.tkrow')?.dataset.id;
      if (!b || !id) return;
      const a = b.dataset.a;
      if (a === 'out') { selected = selected === id ? '' : id; paintJobs(); void paintOutput(); }
      else if (a === 'stop') await jarvin.jobsStop(id);
      else if (a === 'rm') { if (selected === id) selected = ''; await jarvin.jobsRemove(id); }
      else if (a === 'prev' && b.dataset.url) { dlg().close(); deps.openPreview(b.dataset.url); }
    };
    $('tkRecovered').onclick = async (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
      const id = button?.closest<HTMLElement>('.tkrow')?.dataset.id;
      const run = recovered.find((item) => item.id === id);
      if (!button || !run) return;
      if (button.dataset.a === 'review') {
        if (deps.reviewRun(run)) dlg().close();
      } else if (button.dataset.a === 'dismiss' && window.confirm('Remove this recovery record? This does not undo any actions.')) {
        try { await jarvin.dismissRun(run.id); await refreshRecovered(); }
        catch (error: any) { deps.toast(String(error?.message ?? error)); }
      }
    };
    dlg().addEventListener('close', () => clearInterval(tick));
  }

  return {
    wire,
    open,
    refreshRecovered,
    /** Adds a message to wait for the current run. Returns the new queue length, or 0 when it could not be added. */
    enqueue(text: string, images?: string[]): number {
      const r = enqueue(queue, text, images);
      if (!r.added) return 0;
      queue = r.queue;
      paintAll();
      return queue.length;
    },
    /** Called when a run ends. Returns the next message to send, or null (and remembers why it is waiting). */
    onRunEnded(outcome: RunOutcome): QueueItem | null {
      void refreshRecovered();
      const r = nextInQueue(queue, outcome);
      if (r.paused) paused = outcome === 'error' ? 'the last run failed' : outcome === 'paused' ? 'the last run paused' : 'you stopped the last run';
      else paused = '';
      if (r.item) queue = r.rest;
      paintAll();
      if (r.paused && queue.length) deps.toast(`Queue paused (${queue.length} waiting). Open Tasks to continue.`);
      return r.item;
    },
    queued: () => queue.length,
  };
}
