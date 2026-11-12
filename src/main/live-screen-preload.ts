import { contextBridge, ipcRenderer } from 'electron';

interface LiveCommand { id: string; op: 'start' | 'frame' | 'stop'; displayId?: string; sourceId?: string }
contextBridge.exposeInMainWorld('liveScreen', {
  onCommand: (callback: (command: LiveCommand) => void) => ipcRenderer.on('live-screen:command', (_event, command: LiveCommand) => callback(command)),
  reply: (id: string, result: Record<string, unknown>) => ipcRenderer.send('live-screen:reply', { id, ...result }),
});
