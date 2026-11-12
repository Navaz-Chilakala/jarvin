import { validUpdateUrl, type UpdateState } from '../shared/updatecfg';

/** The parts of electron-updater's `autoUpdater` this module uses. Lets tests plug in a fake. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease?: boolean;
  allowDowngrade?: boolean;
  setFeedURL(o: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent?: boolean, forceRunAfter?: boolean): void;
  on(ev: string, cb: (...a: any[]) => void): unknown;
  removeAllListeners?(ev?: string): unknown;
}

export interface UpdaterDeps {
  /** Returns the updater, or throws when the library is not installed. */
  load(): UpdaterLike;
  isPackaged: boolean;
  version: string;
  getUrl(): string | undefined;
  emit(s: UpdateState): void;
}

/** Checks for, downloads and installs updates, one step at a time and only on request. Never installs by itself. */
export function createUpdater(d: UpdaterDeps) {
  let state: UpdateState = { phase: 'idle', version: d.version };
  let up: UpdaterLike | null = null;
  let wiredUrl = '';

  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    d.emit(state);
  };

  function ready(): UpdaterLike | null {
    if (!d.isPackaged) {
      set({ phase: 'off', why: 'dev', error: undefined });
      return null;
    }
    const chk = validUpdateUrl(d.getUrl());
    if (!chk.ok) {
      set({ phase: d.getUrl()?.trim() ? 'error' : 'off', why: 'nourl', error: d.getUrl()?.trim() ? chk.error : undefined });
      return null;
    }
    if (!up) {
      try {
        up = d.load();
      } catch {
        set({ phase: 'off', why: 'missing' });
        return null;
      }
      up.autoDownload = false;
      up.autoInstallOnAppQuit = false;
      up.allowPrerelease = false;
      up.allowDowngrade = false;
      up.on('update-available', (i: any) => set({ phase: 'available', next: String(i?.version ?? ''), error: undefined }));
      up.on('update-not-available', () => set({ phase: 'current', next: undefined, error: undefined }));
      up.on('download-progress', (p: any) => set({ phase: 'downloading', pct: typeof p?.percent === 'number' ? p.percent : undefined }));
      up.on('update-downloaded', (i: any) => set({ phase: 'ready', next: String(i?.version ?? state.next ?? ''), pct: 100 }));
      up.on('error', (e: any) => set({ phase: 'error', error: String(e?.message ?? e).split('\n')[0].slice(0, 300) }));
    }
    if (wiredUrl !== chk.url) {
      up.setFeedURL({ provider: 'generic', url: chk.url! });
      wiredUrl = chk.url!;
    }
    return up;
  }

  return {
    get: () => state,
    /** Show the right "off" reason without contacting anything. */
    refresh() {
      if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'available') return state;
      if (!d.isPackaged) set({ phase: 'off', why: 'dev' });
      else if (!validUpdateUrl(d.getUrl()).ok) set({ phase: 'off', why: 'nourl' });
      else if (state.phase === 'off' || state.phase === 'error') set({ phase: 'idle', why: undefined, error: undefined });
      return state;
    },
    async check(): Promise<UpdateState> {
      if (state.phase === 'downloading' || state.phase === 'ready') return state;
      const u = ready();
      if (!u) return state;
      set({ phase: 'checking', error: undefined });
      try {
        await u.checkForUpdates();
      } catch (e: any) {
        set({ phase: 'error', error: String(e?.message ?? e).split('\n')[0].slice(0, 300) });
      }
      return state;
    },
    async download(): Promise<UpdateState> {
      if (state.phase !== 'available' || !up) return state;
      set({ phase: 'downloading', pct: 0 });
      try {
        await up.downloadUpdate();
      } catch (e: any) {
        set({ phase: 'error', error: String(e?.message ?? e).split('\n')[0].slice(0, 300) });
      }
      return state;
    },
    /** Quits and runs the installer. Only after the download finished. */
    install(): boolean {
      if (state.phase !== 'ready' || !up) return false;
      up.quitAndInstall(false, true);
      return true;
    },
  };
}
