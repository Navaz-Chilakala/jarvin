import { contextBridge, ipcRenderer } from 'electron';

const inv = (c: string, ...a: unknown[]) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('pv', {
  go: (input: string) => inv('pv:go', input),
  back: () => inv('pv:back'),
  forward: () => inv('pv:forward'),
  reload: () => inv('pv:reload'),
  stop: () => inv('pv:stop'),
  devtools: () => inv('pv:devtools'),
  external: () => inv('pv:external'),
  auto: (on: boolean) => inv('pv:auto', on),
  servers: () => inv('pv:servers'),
  shot: () => inv('pv:shot'),
  console: () => inv('pv:console'),
  onState: (cb: (s: unknown) => void) => { ipcRenderer.on('pv:state', (_e, s) => cb(s)); },
});
