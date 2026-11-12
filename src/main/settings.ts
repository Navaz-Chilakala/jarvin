import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/types';
import { voiceDefaults } from '../shared/voice';

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
export const mcpConfigPath = (workspace?: string) => {
  if (workspace) {
    const workspaceConfig = path.join(workspace, '.jarvin', 'mcp.json');
    if (fs.existsSync(workspaceConfig)) return workspaceConfig;
  }
  return path.join(app.getPath('userData'), 'mcp.json');
};

export const mcpConfigSource = (workspace?: string) => {
  if (workspace && fs.existsSync(path.join(workspace, '.jarvin', 'mcp.json'))) return 'workspace';
  return 'user';
};

export const defaults: Settings = {
  baseUrl: 'http://127.0.0.1:11434',
  providerApiKey: '',
  model: '',
  embeddingModel: 'nomic-embed-text',
  numCtx: 16384,
  temperature: 0.2,
  mode: 'ask',
  workspace: '',
  maxSteps: 40,
  shell: 'auto',
  offline: false,
  observationPaused: false,
  excludedApps: [],
  excludedWindowTitles: [],
  voice: { ...voiceDefaults },
};

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const merged = { ...defaults, ...saved, voice: { ...voiceDefaults, ...(saved.voice ?? {}) } };
    merged.observationPaused = saved.observationPaused === true;
    // Settings saved before the microphone switch existed kept "Jarvin" as the gate. The switch is the gate now.
    if (saved.voice && saved.voice.listenOnStart === undefined) merged.voice.wakeWord = false;
    merged.excludedApps = Array.isArray(saved.excludedApps) ? saved.excludedApps.filter((value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 120).slice(0, 30) : [];
    merged.excludedWindowTitles = Array.isArray(saved.excludedWindowTitles) ? saved.excludedWindowTitles.filter((value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 120).slice(0, 30) : [];
    // Drop a saved workspace that no longer exists so the app doesn't crash on load.
    if (merged.workspace) {
      try {
        if (!fs.statSync(merged.workspace).isDirectory()) merged.workspace = '';
      } catch {
        merged.workspace = '';
      }
    }
    return merged;
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current, ...patch, voice: { ...current.voice, ...(patch.voice ?? {}) } };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}
