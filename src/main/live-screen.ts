import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, session } from 'electron';
import { assertDisplayCaptureAllowed, streamCaptureAllowed } from './screen-privacy';
import { captureDisplayFrame } from './tools';
import { isBlackCapture } from './window-capture';
import type { ScreenFrame } from './visual-grounding';

type Command = { id: string; op: 'start' | 'frame' | 'stop'; displayId: string; sourceId?: string };
type Reply = { id: string; ok: boolean; image?: string; error?: string };

/** Keeps the desktop media stream in a private hidden renderer. Pixels cross IPC only on request. */
export class LiveScreenProvider {
  private window: BrowserWindow | null = null;
  private opening: Promise<BrowserWindow> | null = null;
  private started = new Set<string>();
  private starting = new Map<string, Promise<void>>();
  private pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private generation = 0;
  private retryAt = 0;
  private readonly page = pathToFileURL(path.join(__dirname, 'renderer', 'live-screen.html')).href;
  private readonly onReply = (event: Electron.IpcMainEvent, reply: Reply): void => {
    if (!this.window || event.sender !== this.window.webContents || !reply || typeof reply.id !== 'string') return;
    const job = this.pending.get(reply.id);
    if (!job) return;
    this.pending.delete(reply.id);
    clearTimeout(job.timer);
    if (reply.ok) job.resolve(reply);
    else job.reject(new Error(String(reply.error ?? 'Live screen capture failed.')));
  };

  constructor() { ipcMain.on('live-screen:reply', this.onReply); }

  private async open(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    if (this.opening) return this.opening;
    const generation = this.generation;
    const opening = (async () => {
      const partition = session.fromPartition('jarvin-live-screen');
      const allowed = (wc: Electron.WebContents): boolean =>
        !!this.window && !this.window.isDestroyed() && wc === this.window.webContents && wc.getURL() === this.page && streamCaptureAllowed();
      partition.setPermissionRequestHandler((wc, permission, callback, details) => {
        const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        callback(allowed(wc) && (permission === 'display-capture' || (permission === 'media' && types.length > 0 && types.every(type => type === 'video'))));
      });
      partition.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && allowed(wc));
      const hidden = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 1,
        height: 1,
        webPreferences: {
          preload: path.join(__dirname, 'live-screen-preload.js'),
          partition: 'jarvin-live-screen',
          backgroundThrottling: false,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      this.window = hidden;
      hidden.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      hidden.webContents.on('will-navigate', event => event.preventDefault());
      hidden.on('closed', () => { if (this.window === hidden) this.window = null; });
      try {
        await hidden.loadFile(path.join(__dirname, 'renderer', 'live-screen.html'));
        if (generation !== this.generation || hidden.isDestroyed() || !streamCaptureAllowed()) throw new Error('Screen stream was stopped.');
        return hidden;
      } catch (error) {
        if (!hidden.isDestroyed()) hidden.destroy();
        throw error;
      }
    })();
    this.opening = opening;
    try { return await opening; }
    finally { if (this.opening === opening) this.opening = null; }
  }

  private async command(command: Omit<Command, 'id'>, timeoutMs = 6000): Promise<Reply> {
    const hidden = await this.open();
    if (hidden.isDestroyed()) throw new Error('Screen stream was stopped.');
    const id = crypto.randomUUID();
    return await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The live screen stream timed out.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { hidden.webContents.send('live-screen:command', { ...command, id } satisfies Command); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  private async start(displayId: string): Promise<void> {
    if (this.started.has(displayId)) return;
    const existing = this.starting.get(displayId);
    if (existing) return existing;
    const generation = this.generation;
    const job = (async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.display_id === displayId)
        ?? (screen.getAllDisplays().length === 1 && sources.length === 1 ? sources[0] : undefined);
      if (!source || !/^screen:\d+:\d+$/.test(source.id)) throw new Error('Could not find the selected screen source.');
      if (generation !== this.generation || !streamCaptureAllowed()) throw new Error('Screen stream was stopped.');
      await this.command({ op: 'start', displayId, sourceId: source.id }, 12000);
      if (generation !== this.generation || !streamCaptureAllowed()) throw new Error('Screen stream was stopped.');
      this.started.add(displayId);
    })();
    this.starting.set(displayId, job);
    try { await job; }
    finally { if (this.starting.get(displayId) === job) this.starting.delete(displayId); }
  }

  async frame(displayId?: string): Promise<ScreenFrame> {
    await assertDisplayCaptureAllowed();
    if (!streamCaptureAllowed() || Date.now() < this.retryAt) return captureDisplayFrame(displayId);
    const display = displayId === undefined ? screen.getPrimaryDisplay() : screen.getAllDisplays().find(item => String(item.id) === displayId);
    if (!display || display.id < 0) throw new Error('Display is no longer available. List displays again.');
    const id = String(display.id);
    try {
      await this.start(id);
      const reply = await this.command({ op: 'frame', displayId: id });
      if (typeof reply.image !== 'string' || reply.image.length > 32_000_000) throw new Error('Invalid live screen frame.');
      const image = nativeImage.createFromBuffer(Buffer.from(reply.image, 'base64'));
      if (image.isEmpty()) throw new Error('The live screen frame is empty.');
      const fingerprint = image.resize({ width: 64, height: 36 }).toBitmap();
      if (isBlackCapture(fingerprint)) throw new Error('The live screen frame is black or unavailable.');
      const origin = process.platform === 'win32'
        ? screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
        : { x: display.bounds.x, y: display.bounds.y };
      await assertDisplayCaptureAllowed();
      return { image: reply.image, fingerprint, displayId: id, width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor), originX: origin.x, originY: origin.y };
    } catch (error) {
      this.stop();
      this.retryAt = Date.now() + 10_000;
      // The fallback applies the same privacy checks before and after each screenshot.
      return captureDisplayFrame(displayId);
    }
  }

  stop(): void {
    this.generation++;
    this.started.clear();
    this.starting.clear();
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Screen stream was stopped.')); }
    this.pending.clear();
    const hidden = this.window;
    this.window = null;
    if (hidden && !hidden.isDestroyed()) hidden.destroy();
  }

  dispose(): void { this.stop(); ipcMain.off('live-screen:reply', this.onReply); }
}
