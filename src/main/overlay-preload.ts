import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayMsg } from '../shared/voice';

contextBridge.exposeInMainWorld('overlay', {
  onUpdate: (cb: (m: OverlayMsg) => void) => {
    ipcRenderer.on('overlay:update', (_e, m: OverlayMsg) => cb(m));
  },
});
