import type { OverlayMsg } from '../shared/voice';

declare global {
  interface Window {
    overlay: { onUpdate(cb: (m: OverlayMsg) => void): void };
  }
}

const pill = document.getElementById('pill')!;
const txt = document.getElementById('txt')!;
const canvas = document.getElementById('wave') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
const BARS = 22;
const levels: number[] = Array(BARS).fill(0);
let target = 0;
let state: OverlayMsg['state'] = 'listening';

function draw() {
  levels.push(state === 'listening' ? target : state === 'working' ? 0.12 + 0.1 * Math.sin(Date.now() / 160) : 0.05);
  levels.shift();
  g.clearRect(0, 0, canvas.width, canvas.height);
  const bw = canvas.width / BARS;
  g.fillStyle = state === 'listening' ? '#8b9bff' : state === 'done' ? '#4ade80' : '#6e6e7a';
  levels.forEach((v, i) => {
    const h = Math.max(3, Math.min(canvas.height, v * canvas.height * 1.6));
    g.fillRect(i * bw + 1.5, (canvas.height - h) / 2, bw - 3, h);
  });
  setTimeout(() => requestAnimationFrame(draw), 40);
}
requestAnimationFrame(draw);

window.overlay.onUpdate((m) => {
  state = m.state;
  pill.className = 'pill ' + m.state;
  if (m.level !== undefined) target = Math.min(1, m.level * 9);
  const tail = (m.text ?? '').trim();
  txt.textContent =
    m.state === 'listening' ? (tail ? '…' + tail.slice(-46) : 'Listening…') : m.state === 'working' ? 'Transcribing…' : m.state === 'done' ? tail || 'Done' : tail || 'Something went wrong';
});
