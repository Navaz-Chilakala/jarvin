import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { OverlayMsg } from '../shared/voice';

const W = 400;
const H = 56;

/** Small always-on-top pill with a waveform and status. It never takes focus or mouse input. */
export class OverlayWindow {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private pending: OverlayMsg | null = null;
  private hideTimer: NodeJS.Timeout | null = null;

  private create(): BrowserWindow {
    const w = new BrowserWindow({
      width: W,
      height: H,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(true);
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.webContents.on('did-finish-load', () => {
      this.loaded = true;
      if (this.pending) w.webContents.send('overlay:update', this.pending);
    });
    w.on('closed', () => {
      this.win = null;
      this.loaded = false;
    });
    void w.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
    return w;
  }

  private place(w: BrowserWindow) {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = d.workArea;
    w.setBounds({ x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + wa.height - H - 56), width: W, height: H });
  }

  update(m: OverlayMsg) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (m.state === 'hidden') return this.hide();
    this.win ??= this.create();
    if (!this.win.isVisible()) {
      this.place(this.win);
      this.win.showInactive();
    }
    this.pending = m;
    if (this.loaded) this.win.webContents.send('overlay:update', m);
    if (m.state === 'done') this.hideTimer = setTimeout(() => this.hide(), 1200);
    else if (m.state === 'error') this.hideTimer = setTimeout(() => this.hide(), 3500);
  }

  hide() {
    this.pending = null;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  dispose() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
