import { contextBridge, ipcRenderer } from 'electron';
import type { AssistantWidgetAction, AssistantWidgetState } from '../shared/assistant-widget';

contextBridge.exposeInMainWorld('assistantWidget', {
  act: (action: AssistantWidgetAction) => ipcRenderer.send('assistant-widget:action', action),
  move: (point: { screenX: number; screenY: number; offsetX: number; offsetY: number }) => ipcRenderer.send('assistant-widget:move', point),
  onState: (cb: (state: AssistantWidgetState) => void) => ipcRenderer.on('assistant-widget:state', (_event, state: AssistantWidgetState) => cb(state)),
});
