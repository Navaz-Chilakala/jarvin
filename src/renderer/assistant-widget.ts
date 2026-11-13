import type { AssistantWidgetAction, AssistantWidgetState } from '../shared/assistant-widget';
declare global { interface Window { assistantWidget: { act(action: AssistantWidgetAction): void; move(point: { screenX: number; screenY: number; offsetX: number; offsetY: number }): void; onState(cb: (state: AssistantWidgetState) => void): void } } }
const $ = (id: string) => document.getElementById(id)!;
const pet = $('pet');
let drag: { pointerId: number; screenX: number; screenY: number; offsetX: number; offsetY: number; moved: boolean } | null = null;
let suppressClick = false;
pet.onpointerdown = (event: PointerEvent) => {
  if (event.button !== 0) return;
  drag = { pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY, offsetX: event.clientX, offsetY: event.clientY, moved: false };
  pet.setPointerCapture(event.pointerId);
};
pet.onpointerup = (event: PointerEvent) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (drag.moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  }
  drag = null;
  pet.classList.remove('dragging');
  if (pet.hasPointerCapture(event.pointerId)) pet.releasePointerCapture(event.pointerId);
};
pet.onpointercancel = () => { drag = null; pet.classList.remove('dragging'); };
pet.onclick = (event) => {
  if (suppressClick) { event.preventDefault(); suppressClick = false; return; }
  window.assistantWidget.act('assistant');
};
$('pet').onpointermove = (event: PointerEvent) => {
  if (drag && drag.pointerId === event.pointerId) {
    if (!drag.moved && Math.hypot(event.screenX - drag.screenX, event.screenY - drag.screenY) >= 6) {
      drag.moved = true; pet.classList.add('dragging');
    }
    if (drag.moved) window.assistantWidget.move({ screenX: event.screenX, screenY: event.screenY, offsetX: drag.offsetX, offsetY: drag.offsetY });
    return;
  }
  const box = $('pet').getBoundingClientRect();
  const x = Math.max(-2, Math.min(2, ((event.clientX - box.left) / box.width - .5) * 4));
  const y = Math.max(-1.5, Math.min(1.5, ((event.clientY - box.top) / box.height - .5) * 3));
  document.body.style.setProperty('--look-x', `${x.toFixed(1)}px`);
  document.body.style.setProperty('--look-y', `${y.toFixed(1)}px`);
};
$('pet').onpointerleave = () => { document.body.style.removeProperty('--look-x'); document.body.style.removeProperty('--look-y'); };
// Pose pictures are optional. Each is used only once it has loaded, so a missing file simply leaves the standing pose.
const picture = document.querySelector<HTMLImageElement>('#pet .robot')!;
const poses: Record<string, string> = { idle: 'pet.png' };
for (const name of ['wave', 'listen', 'think']) {
  const probe = new Image();
  probe.onload = () => { poses[name] = probe.src; };
  probe.src = `pet-${name}.png`;
}
function showPose(name: string) {
  const src = poses[name] ?? poses.idle;
  if (picture.getAttribute('src') !== src && picture.src !== src) picture.src = src;
}
const micToggle = $('micToggle');
// A short click switches the microphone on or off. Holding the button is push-to-talk: record while held, send on release.
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let talking = false;
micToggle.onpointerdown = (event) => {
  event.stopPropagation();
  if (event.button !== 0) return;
  try { micToggle.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
  holdTimer = setTimeout(() => { holdTimer = null; talking = true; window.assistantWidget.act('talk-start'); }, 400);
};
const endPress = (event: Event, cancelled: boolean) => {
  event.stopPropagation();
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; if (!cancelled) window.assistantWidget.act('mute'); }
  else if (talking) { talking = false; window.assistantWidget.act('talk-end'); }
};
micToggle.onpointerup = (event) => endPress(event, false);
micToggle.onpointercancel = (event) => endPress(event, true);
micToggle.onclick = (event) => { event.stopPropagation(); if (event.detail === 0) window.assistantWidget.act('mute'); };
window.assistantWidget.onState((s) => {
  const micOn = s.mic === 'listening' || s.mic === 'recording' || s.mic === 'processing';
  micToggle.title = micOn ? 'Microphone is on. Click to turn it off.' : s.mic === 'error' ? 'Microphone problem. Click to retry.' : 'Microphone is off. Click to turn it on.';
  micToggle.setAttribute('aria-label', micToggle.title);
  micToggle.setAttribute('aria-pressed', String(micOn));
  showPose(s.speaking ? 'wave' : (s.hearing === true && s.mic === 'listening') || s.mic === 'recording' ? 'listen' : s.working || s.desktop === 'observing' || s.desktop === 'controlling' || s.mic === 'processing' ? 'think' : 'idle');
  document.body.dataset.attention = String(s.attention);
  document.body.dataset.mic = s.mic;
  document.body.dataset.desktop = s.desktop;
  document.body.dataset.watching = String(s.watching === true);
  document.body.dataset.observationPaused = String(s.observationPaused === true);
  document.body.dataset.screenBlocked = String(s.screenBlocked === true);
  document.body.dataset.working = String(s.working);
  document.body.dataset.speaking = String(s.speaking);
  document.body.dataset.hearing = String(s.hearing === true && s.mic === 'listening');
  document.body.style.setProperty('--mic-level', String(s.mic === 'listening' ? Math.max(0, Math.min(1, s.level || 0)) : 0));
  const suffix = s.mic === 'listening' ? ' · mic on' : s.mic === 'paused' ? ' · mic paused' : '';
  const ended = s.outcome === 'finished' ? 'Reply ready' : s.outcome === 'failed' ? 'Task failed' : s.outcome === 'stopped' ? 'Stopped' : s.outcome === 'paused' ? 'Task paused' : '';
  $('status').textContent = s.attention ? `Needs your input${suffix}` : s.speaking ? 'Speaking' : s.desktop === 'observing' ? `Seeing screen${suffix}` : s.desktop === 'controlling' ? `Controlling window${suffix}` : s.mic === 'recording' ? 'Recording' : s.mic === 'processing' ? 'Processing voice' : s.mic === 'error' ? 'Microphone error' : s.working ? `Working${suffix}` : s.jobs ? `${s.jobs} background job${s.jobs === 1 ? '' : 's'}${suffix}` : s.observationPaused ? `Screen paused${suffix}` : s.screenBlocked ? `Screen excluded${suffix}` : ended ? `${ended}${suffix || ' · mic off'}` : s.watching ? `Watching screen${suffix}` : s.mic === 'listening' ? 'Mic listening' : s.mic === 'paused' ? 'Mic paused' : 'Ready · mic off';
  $('pet').title = `${$('status').textContent} · Drag to move · Click to open · Right-click for controls`;
});
