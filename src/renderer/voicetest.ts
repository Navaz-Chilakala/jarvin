import type { JarvinApi, Settings } from '../shared/types';
import type { WhisperSize } from '../shared/voice';
import { shortModelName, type VoiceTestModel, type VoiceTestReport } from '../shared/voicetest';
import { esc } from './markdown';
import { Recorder } from './voiceui';

/** Which voice setting selects each recognizer, for the "Use this one" button. */
const SIZE_FOR: Record<string, WhisperSize> = {
  'sherpa-onnx/qwen3-asr-0.6b-int8': 'qwen3-asr',
  'distil-whisper/distil-small.en': 'distil-small',
  'Xenova/whisper-base.en': 'base',
  'Xenova/whisper-small.en': 'small',
  'onnx-community/moonshine-base-ONNX': 'moonshine',
};

const STYLE = `
#vtDlg { width:min(760px,94vw); max-height:90vh; padding:0; border:1px solid #ffffff22; border-radius:14px; background:#17171c; color:#e9e9ee; }
#vtDlg::backdrop { background:#000a; }
#vtDlg .vt-pad { padding:18px 20px; }
#vtDlg h3 { margin:0 0 6px; font-size:17px; }
#vtDlg .vt-say { margin:14px 0; padding:18px; border-radius:12px; background:#22232b; font-size:21px; line-height:1.35; text-align:center; }
#vtDlg .vt-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
#vtDlg .vt-bar { height:6px; border-radius:3px; background:#2b2c35; overflow:hidden; margin-top:10px; }
#vtDlg .vt-bar > i { display:block; height:100%; width:0; background:#5fe3a8; transition:width .15s; }
#vtDlg table { width:100%; border-collapse:collapse; margin-top:10px; font-size:13px; }
#vtDlg th, #vtDlg td { text-align:left; padding:6px 8px; border-bottom:1px solid #ffffff14; vertical-align:top; }
#vtDlg td.n, #vtDlg th.n { text-align:right; white-space:nowrap; }
#vtDlg tr.best td { background:#1f3a2e; }
#vtDlg .vt-miss { color:#ffb3b3; }
#vtDlg .rec { background:#c0392b; border-color:#c0392b; color:#fff; }
`;

/**
 * The voice test dialog: read each sentence once, then compare every installed recognizer on those recordings.
 * Recordings stay on this PC. Automatic listening is switched off while the dialog is open.
 */
export function initVoiceTest(d: { jarvin: JarvinApi; getSettings: () => Settings; setSettings: (patch: Partial<Settings>) => Promise<void>; setListeningPaused: (paused: boolean) => void; toast: (text: string) => void }) {
  const style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);
  const dlg = document.createElement('dialog'); dlg.id = 'vtDlg';
  dlg.innerHTML = `<div class="vt-pad">
    <h3>Voice test</h3>
    <div class="hint">Read each sentence once in your normal voice. Jarvin keeps the recordings on this PC and uses them to compare its speech recognizers on your voice. It takes about five minutes.</div>
    <div id="vtRecord">
      <div class="hint" id="vtCount" style="margin-top:12px"></div>
      <div class="vt-say" id="vtSay"></div>
      <div class="vt-bar"><i id="vtLevel"></i></div>
      <div class="vt-row">
        <button type="button" class="btn primary" id="vtRec">Record</button>
        <button type="button" class="btn" id="vtPrev">Previous</button>
        <button type="button" class="btn" id="vtNext">Skip</button>
        <span class="hint" id="vtMsg" role="status"></span>
      </div>
    </div>
    <div class="vt-row" style="margin-top:16px">
      <button type="button" class="btn primary" id="vtRun">Run the comparison</button>
      <button type="button" class="btn" id="vtClear">Delete my recordings</button>
      <span style="flex:1"></span>
      <button type="button" class="btn" id="vtClose">Close</button>
    </div>
    <div class="hint" id="vtProgress" role="status"></div>
    <div id="vtResults"></div>
  </div>`;
  document.body.appendChild(dlg);
  const $ = <T extends HTMLElement>(id: string) => dlg.querySelector<T>(`#${id}`)!;

  let sentences: string[] = [];
  let recorded = new Set<number>();
  let at = 0;
  let recorder: Recorder | null = null;
  let busy = false;

  const firstMissing = () => { for (let i = 0; i < sentences.length; i++) if (!recorded.has(i)) return i; return sentences.length - 1; };
  function paint() {
    $('vtCount').textContent = `Sentence ${at + 1} of ${sentences.length} · ${recorded.size} recorded${recorded.has(at) ? ' · this one is recorded (record again to replace it)' : ''}`;
    $('vtSay').textContent = sentences[at] ?? '';
    $<HTMLButtonElement>('vtRec').textContent = recorder ? 'Stop' : recorded.has(at) ? 'Record again' : 'Record';
    $('vtRec').classList.toggle('rec', !!recorder);
    $<HTMLButtonElement>('vtPrev').disabled = !!recorder || at === 0;
    $<HTMLButtonElement>('vtNext').disabled = !!recorder || at >= sentences.length - 1;
    $<HTMLButtonElement>('vtNext').textContent = recorded.has(at) ? 'Next' : 'Skip';
    $<HTMLButtonElement>('vtRun').disabled = busy || !!recorder || recorded.size < 5;
    $<HTMLButtonElement>('vtClear').disabled = busy || !!recorder || recorded.size === 0;
    $('vtRun').title = recorded.size < 5 ? 'Record at least 5 sentences first.' : '';
  }

  function row(m: VoiceTestModel, best: boolean): string {
    if (m.failed) return `<tr><td>${esc(shortModelName(m.model))}</td><td colspan="4" class="vt-miss">Could not run: ${esc(m.failed)}</td><td></td></tr>`;
    const use = SIZE_FOR[m.model] ? `<button type="button" class="btn small" data-use="${esc(m.model)}">Use this one</button>` : '';
    return `<tr class="${best ? 'best' : ''}"><td><strong>${esc(shortModelName(m.model))}</strong>${best ? ' · best' : ''}</td><td class="n">${m.errors} of ${m.words} (${m.errorRate}%)</td><td class="n">${m.exactSentences} of ${m.lines.length}</td><td class="n">${m.nameHeard} of ${m.nameExpected}</td><td class="n">${(m.avgMs / 1000).toFixed(1)} s</td><td>${use}</td></tr>`;
  }
  function showReport(report: VoiceTestReport | null) {
    const box = $('vtResults');
    if (!report) { box.innerHTML = ''; return; }
    const ok = report.models.filter((m) => !m.failed);
    const best = ok[0];
    const misses = best ? best.lines.filter((l) => l.errors > 0 || (l.nameExpected && !l.nameHeard)).slice(0, 8) : [];
    box.innerHTML = `<table><thead><tr><th>Recognizer</th><th class="n">Wrong words</th><th class="n">Sentences exact</th><th class="n">"Hey Jarvin" heard</th><th class="n">Time each</th><th></th></tr></thead><tbody>${report.models.map((m) => row(m, m === best)).join('')}</tbody></table>
      <div class="hint" style="margin-top:8px">Tested ${new Date(report.at).toLocaleString()} on ${report.clips} of your recordings. Fewer wrong words is better; the name column shows how often the wake phrase was recognised.</div>
      ${misses.length ? `<table><thead><tr><th>You said</th><th>${esc(shortModelName(best.model))} heard</th></tr></thead><tbody>${misses.map((l) => `<tr><td>${esc(l.expected)}</td><td class="vt-miss">${esc(l.heard || '(nothing)')}</td></tr>`).join('')}</tbody></table>` : best ? '<div class="hint" style="margin-top:8px">The best recognizer got every recorded sentence right.</div>' : ''}`;
  }

  async function refresh() {
    const s = await d.jarvin.voiceTestStatus();
    sentences = s.sentences; recorded = new Set(s.recorded); busy = s.running;
    showReport(s.report);
    paint();
  }

  $('vtRec').onclick = async () => {
    const msg = $('vtMsg');
    if (recorder) {
      const audio = recorder.stop(); recorder = null; $('vtLevel').style.width = '0';
      try { recorded = new Set(await d.jarvin.voiceTestSave(at, audio)); msg.textContent = 'Saved.'; if (at < sentences.length - 1) at++; }
      catch (e: any) { msg.textContent = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
      paint();
      return;
    }
    try {
      const r = new Recorder();
      await r.start((_chunk, level) => { $('vtLevel').style.width = `${Math.min(100, Math.round(level * 900))}%`; });
      recorder = r; msg.textContent = 'Recording… read the sentence, then press Stop.';
    } catch (e: any) { msg.textContent = /denied|permission/i.test(String(e?.message)) ? 'Microphone access was blocked.' : `Could not open the microphone: ${e?.message ?? e}`; }
    paint();
  };
  $('vtPrev').onclick = () => { if (at > 0) at--; $('vtMsg').textContent = ''; paint(); };
  $('vtNext').onclick = () => { if (at < sentences.length - 1) at++; $('vtMsg').textContent = ''; paint(); };
  $('vtClear').onclick = async () => {
    if (!window.confirm('Delete your voice test recordings and results from this PC?')) return;
    try { await d.jarvin.voiceTestClear(); at = 0; await refresh(); d.toast('Voice test recordings deleted.'); }
    catch (e: any) { d.toast(String(e?.message ?? e)); }
  };
  $('vtRun').onclick = async () => {
    busy = true; paint();
    $('vtProgress').textContent = 'Starting…';
    const off = d.jarvin.onVoiceTestProgress((p) => { $('vtProgress').textContent = `Testing ${shortModelName(p.model)}: ${p.done} of ${p.total}`; });
    try { showReport(await d.jarvin.voiceTestRun()); $('vtProgress').textContent = 'Done.'; }
    catch (e: any) { $('vtProgress').textContent = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    finally { off(); busy = false; paint(); }
  };
  $('vtResults').onclick = async (e) => {
    const model = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-use]')?.dataset.use;
    const size = model ? SIZE_FOR[model] : undefined;
    if (!size) return;
    await d.setSettings({ voice: { ...d.getSettings().voice, size } } as Partial<Settings>);
    d.toast(`Jarvin will now listen with ${shortModelName(model!)}.`);
  };
  const close = () => { recorder?.cancel(); recorder = null; dlg.close(); };
  $('vtClose').onclick = close;
  dlg.addEventListener('close', () => { recorder?.cancel(); recorder = null; d.setListeningPaused(false); });

  return {
    async open() {
      d.setListeningPaused(true);
      await refresh();
      at = firstMissing();
      $('vtMsg').textContent = ''; $('vtProgress').textContent = '';
      paint();
      dlg.showModal();
    },
  };
}
