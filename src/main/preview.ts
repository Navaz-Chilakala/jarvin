import { app, BrowserWindow, WebContentsView, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { allowedNavigation, consoleReport, isConsoleNoise, isLocalHost, parsePreviewTarget, type ConsoleItem } from '../shared/previewurl';
import { resolveSafe } from './tools';
import { assertScreenObservationAllowed, isExcludedWindow } from './screen-privacy';

export const TOOLBAR_H = 70;
export const DEV_PORTS = [3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8888, 9000, 1313];

export interface PreviewState {
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  errors: number;
  auto: boolean;
  error?: string;
}

export type ToChat = { kind: 'image'; base64: string; note: string } | { kind: 'text'; text: string };

export interface PreviewDeps {
  workspace(): string;
  offline(): boolean;
  toChat(m: ToChat): void;
  log(m: string): void;
}

/** Which of the usual dev-server ports have something listening (checks both IPv4 and IPv6 loopback). */
export function probePorts(ports: number[], timeoutMs = 300): Promise<number[]> {
  const one = (port: number, host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host });
      const done = (ok: boolean) => { s.destroy(); resolve(ok); };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  return Promise.all(ports.map(async (p) => ((await one(p, '127.0.0.1')) || (await one(p, '::1')) ? p : 0))).then((r) => r.filter(Boolean));
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * A separate window with an address bar on top and the page underneath.
 * The page runs in its own sandboxed view: no Node, no Jarvin API, no saved sign-ins, no permissions,
 * and it can only reach web addresses and files inside the open project.
 */
export class PreviewWindow {
  private win: BrowserWindow | null = null;
  private view: WebContentsView | null = null;
  private errors: ConsoleItem[] = [];
  private auto = true;
  private lastError: string | undefined;
  private pendingTarget = '';
  private loadedToolbar = false;

  constructor(private deps: PreviewDeps) {
    const guard = <T>(fn: (e: IpcMainInvokeEvent, ...a: any[]) => T) => (e: IpcMainInvokeEvent, ...a: any[]) => {
      if (!this.win || e.sender !== this.win.webContents) throw new Error('Not allowed.');
      return fn(e, ...a);
    };
    ipcMain.handle('pv:go', guard((_e, input: string) => this.go(input)));
    ipcMain.handle('pv:back', guard(() => { const h = this.view?.webContents.navigationHistory; if (h?.canGoBack()) h.goBack(); }));
    ipcMain.handle('pv:forward', guard(() => { const h = this.view?.webContents.navigationHistory; if (h?.canGoForward()) h.goForward(); }));
    ipcMain.handle('pv:reload', guard(() => this.view?.webContents.reloadIgnoringCache()));
    ipcMain.handle('pv:stop', guard(() => this.view?.webContents.stop()));
    ipcMain.handle('pv:devtools', guard(() => { const wc = this.view?.webContents; if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' }); }));
    ipcMain.handle('pv:external', guard(() => { const u = this.view?.webContents.getURL() ?? ''; if (/^https?:/i.test(u)) void shell.openExternal(u); }));
    ipcMain.handle('pv:auto', guard((_e, on: boolean) => { this.auto = !!on; this.push(); }));
    ipcMain.handle('pv:servers', guard(() => probePorts(DEV_PORTS)));
    ipcMain.handle('pv:shot', guard(() => this.shot()));
    ipcMain.handle('pv:console', guard(() => this.sendConsole()));
  }

  get isOpen() { return !!this.win && !this.win.isDestroyed(); }

  /** Opens the window (or brings it forward) and, if a target is given, loads it. */
  open(target?: string): { ok: boolean; error?: string } {
    if (!this.isOpen) this.create();
    this.win!.show();
    this.win!.focus();
    if (target && target.trim()) {
      if (this.loadedToolbar) return this.go(target);
      this.pendingTarget = target;
    }
    return { ok: true };
  }

  private create() {
    const w = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 640,
      minHeight: 420,
      title: 'Jarvin Preview',
      backgroundColor: '#121215',
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preview-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.setMenuBarVisibility(false);
    this.win = w;
    this.loadedToolbar = false;
    this.errors = [];
    this.lastError = undefined;
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());

    const v = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'jarvin-preview', webSecurity: true, allowRunningInsecureContent: false },
    });
    this.view = v;
    w.contentView.addChildView(v);
    this.layout();
    w.on('resize', () => this.layout());
    w.on('closed', () => { this.win = null; this.view = null; this.loadedToolbar = false; });
    this.hardenSession(v);
    this.watchPage(v);

    w.webContents.on('did-finish-load', () => {
      this.loadedToolbar = true;
      this.push();
      if (this.pendingTarget) { const t = this.pendingTarget; this.pendingTarget = ''; this.go(t); }
    });
    void w.loadFile(path.join(__dirname, 'renderer', 'preview.html'));
  }

  private layout() {
    if (!this.win || !this.view) return;
    const b = this.win.getContentBounds();
    this.view.setBounds({ x: 0, y: TOOLBAR_H, width: Math.max(1, b.width), height: Math.max(1, b.height - TOOLBAR_H) });
  }

  private hardenSession(v: WebContentsView) {
    const ses = v.webContents.session;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
    ses.webRequest.onBeforeRequest((d, cb) => {
      let u: URL;
      try { u = new URL(d.url); } catch { return cb({ cancel: true }); }
      if (u.protocol === 'file:') return cb({ cancel: !allowedNavigation(d.url, this.deps.workspace()) });
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:') {
        return cb({ cancel: this.deps.offline() && !isLocalHost(u.hostname) });
      }
      // data:, blob:, devtools:, chrome-extension: and the like are fine for the page's own use.
      cb({ cancel: false });
    });
  }

  private watchPage(v: WebContentsView) {
    const wc = v.webContents;
    const block = (e: { preventDefault(): void }, url: string) => {
      if (url.startsWith('data:text/html') ) return;
      if (!allowedNavigation(url, this.deps.workspace()) || (this.deps.offline() && /^https?:/i.test(url) && !isLocalHost(new URL(url).hostname))) {
        e.preventDefault();
        this.lastError = /^https?:/i.test(url) && this.deps.offline() ? 'Offline mode is on, so only localhost pages open.' : `Blocked a navigation to ${url.slice(0, 80)}`;
        this.push();
      }
    };
    wc.on('will-navigate', (e) => block(e, e.url));
    wc.on('will-redirect', (e) => block(e, e.url));
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && !this.deps.offline()) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('did-start-navigation', (d: any) => {
      const main = d?.isMainFrame ?? true;
      const same = d?.isSameDocument ?? false;
      if (main && !same) { this.errors = []; this.lastError = undefined; }
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3 = aborted by a newer navigation
      this.lastError = `Could not load ${url.slice(0, 120)}: ${desc}`;
      this.errors.push({ level: 'error', text: `Failed to load ${url}: ${desc} (${code})` });
      this.push();
    });
    // Electron 33 passes (event, level, message, line, sourceId); newer versions put these on the event.
    wc.on('console-message', ((e: any, level: any, message: any, line: any, sourceId: any) => {
      const ev = e && typeof e === 'object' && 'message' in e ? e : { level, message, lineNumber: line, sourceId };
      const lv = ev.level;
      const kind = lv === 3 || lv === 'error' ? 'error' : lv === 2 || lv === 'warning' ? 'warning' : null;
      if (!kind || isConsoleNoise(String(ev.message ?? ''))) return;
      if (this.errors.length < 200) this.errors.push({ level: kind, text: String(ev.message ?? ''), source: ev.sourceId ? String(ev.sourceId) : undefined, line: Number(ev.lineNumber ?? ev.line) || undefined });
      this.push();
    }) as any);
    const poke = () => this.push();
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(ev as any, poke);
  }

  go(input: string): { ok: boolean; error?: string } {
    if (!this.view) return { ok: false, error: 'The preview window is not open.' };
    const t = parsePreviewTarget(input);
    if (!t.ok) { this.lastError = t.error; this.push(); return { ok: false, error: t.error }; }
    const wc = this.view.webContents;
    this.lastError = undefined;
    try {
      if ('file' in t) {
        const ws = this.deps.workspace();
        if (!ws) throw new Error('Open a project folder first.');
        const rel = path.isAbsolute(t.file) ? path.relative(ws, t.file) : t.file;
        const abs = resolveSafe(ws, rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`No file named ${t.file} in the project.`);
        this.auto = true;
        if (/\.(md|markdown)$/i.test(abs)) {
          const text = fs.readFileSync(abs, 'utf8').slice(0, 1_000_000);
          const html = `<!doctype html><meta charset="utf-8"><title>${escHtml(path.basename(abs))}</title><body style="font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;white-space:pre-wrap">${escHtml(text)}`;
          void wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        } else void wc.loadURL(pathToFileURL(abs).toString());
      } else {
        if (this.deps.offline() && !isLocalHost(new URL(t.url).hostname)) throw new Error('Offline mode is on, so only localhost pages open.');
        this.auto = false;
        void wc.loadURL(t.url);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      this.lastError = msg;
      this.push();
      return { ok: false, error: msg };
    }
    this.push();
    return { ok: true };
  }

  /** The project folder changed on disk. Reload when auto-reload is on. */
  fsChanged() {
    if (!this.isOpen || !this.view || !this.auto) return;
    const wc = this.view.webContents;
    if (wc.isLoading() || !wc.getURL() || wc.getURL().startsWith('data:')) return;
    wc.reloadIgnoringCache();
  }

  state(): PreviewState {
    const wc = this.view?.webContents;
    const h = wc?.navigationHistory;
    const url = wc && !wc.isDestroyed() ? wc.getURL() : '';
    return {
      url: url.startsWith('data:') ? '' : url,
      title: wc && !wc.isDestroyed() ? wc.getTitle() : '',
      loading: !!wc && !wc.isDestroyed() && wc.isLoading(),
      canBack: !!h?.canGoBack(),
      canForward: !!h?.canGoForward(),
      errors: this.errors.length,
      auto: this.auto,
      error: this.lastError,
    };
  }

  private push() {
    if (!this.isOpen || !this.loadedToolbar) return;
    this.win!.webContents.send('pv:state', this.state());
  }

  private async shot() {
    assertScreenObservationAllowed();
    if (isExcludedWindow({ app: app.getName(), title: this.state().title })) throw new Error('This preview window is excluded in Privacy settings.');
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) throw new Error('Nothing to capture.');
    let img = await wc.capturePage();
    const { width } = img.getSize();
    if (width > 1600) img = img.resize({ width: 1600, quality: 'good' });
    const png = img.toPNG();
    if (!png.length) throw new Error('The page is blank, so there is nothing to capture.');
    assertScreenObservationAllowed();
    if (isExcludedWindow({ app: app.getName(), title: this.state().title })) throw new Error('This preview window is excluded in Privacy settings.');
    this.deps.toChat({ kind: 'image', base64: png.toString('base64'), note: `Screenshot of ${this.state().url || 'the preview'}` });
    return true;
  }

  private sendConsole() {
    const text = consoleReport(this.state().url, this.errors);
    if (!text) return false;
    this.deps.toChat({ kind: 'text', text });
    return true;
  }

  dispose() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.view = null;
  }
}
