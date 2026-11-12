import { BrowserWindow, Menu, screen, type WebContents } from 'electron';
import path from 'node:path';
import type { AssistantWidgetAction, AssistantWidgetState } from '../shared/assistant-widget';

/** A small, interactive companion. The main window continues owning chat and microphone access. */
export class AssistantWidget {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private state: AssistantWidgetState = { working: false, speaking: false, attention: false, jobs: 0, desktop: 'off', outcome: 'ready', mic: 'off', observationPaused: false };
  constructor(private onUnavailable: () => void, private onAction: (action: AssistantWidgetAction) => void = () => {}) {}

  show(): void {
    if (!this.win || this.win.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = 122, height = 156;
      const w = new BrowserWindow({
        x: Math.round(area.x + area.width - width - 24), y: Math.round(area.y + area.height - height - 24),
        width, height, minWidth: width, minHeight: height, show: false, frame: false, transparent: true,
        resizable: false, movable: true, focusable: true, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
        webPreferences: { preload: path.join(__dirname, 'assistant-widget-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      this.win = w;
      // Keep the companion above other always-on-top app windows as well.
      w.setAlwaysOnTop(true, 'screen-saver');
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('context-menu', () => {
        Menu.buildFromTemplate([
          { label: 'Open Jarvin', click: () => this.onAction('assistant') },
          { label: this.state.mic === 'off' || this.state.mic === 'error' ? 'Resume microphone' : 'Mute microphone', click: () => this.onAction('mute') },
          { label: this.state.observationPaused ? 'Resume screen observation' : 'Pause screen observation', click: () => this.onAction('observation') },
          { label: 'Open code', click: () => this.onAction('code') },
          { label: 'Review paused tasks', click: () => this.onAction('tasks') },
          { type: 'separator' },
          { label: 'Pause task', enabled: this.state.working, click: () => this.onAction('pause') },
          { label: 'Stop reply', click: () => this.onAction('stop') },
          { type: 'separator' },
          { label: 'Quit Jarvin', click: () => this.onAction('quit') },
        ]).popup({ window: w });
      });
      w.webContents.on('will-navigate', (e) => e.preventDefault());
      w.webContents.on('did-finish-load', () => { this.loaded = true; this.push(); });
      w.webContents.on('render-process-gone', () => { if (!w.isDestroyed()) w.destroy(); });
      w.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3 && !w.isDestroyed()) w.destroy(); });
      w.on('closed', () => { if (this.win === w) { this.win = null; this.loaded = false; this.onUnavailable(); } });
      void w.loadFile(path.join(__dirname, 'renderer', 'assistant-widget.html'));
    }
    if (!(process.env.JARVIN_E2E === '1' && process.env.JARVIN_E2E_HEADLESS === '1')) {
      this.win.showInactive();
      this.win.moveTop();
    }
  }

  owns(sender: WebContents): boolean { return !!this.win && !this.win.isDestroyed() && sender === this.win.webContents; }
  move(sender: WebContents, point: { screenX?: number; screenY?: number; offsetX?: number; offsetY?: number }): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.owns(sender)) return;
    const { screenX, screenY, offsetX, offsetY } = point ?? {};
    if (![screenX, screenY, offsetX, offsetY].every(Number.isFinite)) return;
    if (offsetX! < 0 || offsetX! > 122 || offsetY! < 0 || offsetY! > 156) return;
    const area = screen.getDisplayNearestPoint({ x: Math.round(screenX!), y: Math.round(screenY!) }).workArea;
    const bounds = win.getBounds();
    const x = Math.max(area.x, Math.min(area.x + area.width - bounds.width, Math.round(screenX! - offsetX!)));
    const y = Math.max(area.y, Math.min(area.y + area.height - bounds.height, Math.round(screenY! - offsetY!)));
    win.setPosition(x, y);
  }
  update(state: Pick<AssistantWidgetState, 'working' | 'mic' | 'speaking' | 'level' | 'hearing'>): void { this.state = { ...this.state, ...state, outcome: state.working && !this.state.working ? 'ready' : this.state.outcome }; this.push(); }
  jobs(count: number): void { this.state = { ...this.state, jobs: count }; this.push(); }
  desktop(state: AssistantWidgetState['desktop']): void { this.state = { ...this.state, desktop: state }; this.push(); }
  watching(value: boolean): void { this.state = { ...this.state, watching: value }; this.push(); }
  observationPaused(value: boolean): void { this.state = { ...this.state, observationPaused: value, watching: value ? false : this.state.watching }; this.push(); }
  screenBlocked(value: boolean): void { this.state = { ...this.state, screenBlocked: value, watching: value ? false : this.state.watching }; this.push(); }
  attention(): void { this.state = { ...this.state, attention: true }; this.push(); }
  clearAttention(): void { this.state = { ...this.state, attention: false }; this.push(); }
  complete(outcome: AssistantWidgetState['outcome']): void { this.state = { ...this.state, attention: false, outcome }; this.push(); }
  private push(): void { if (this.loaded && this.win && !this.win.isDestroyed()) this.win.webContents.send('assistant-widget:state', this.state); }
  hide(): void { if (this.win && !this.win.isDestroyed()) this.win.hide(); }
  dispose(): void { const old = this.win; this.win = null; this.loaded = false; if (old && !old.isDestroyed()) old.destroy(); }
}
