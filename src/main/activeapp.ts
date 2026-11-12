import { execFile } from 'node:child_process';
import { ACTIVE_APP_PS, parseActiveApp, type ActiveApp } from '../shared/apprules';

/** Which app has focus right now. Windows only; elsewhere (or on failure) there is no answer and no rule applies. */
export function detectActiveApp(platform: string = process.platform): Promise<ActiveApp | null> {
  const fake = process.env.JARVIN_E2E === '1' ? process.env.JARVIN_E2E_ACTIVE_APP : undefined;
  if (fake) return Promise.resolve(parseActiveApp(fake));
  if (platform !== 'win32') return Promise.resolve(null);
  const encoded = Buffer.from(ACTIVE_APP_PS, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, timeout: 8000 }, (err, stdout) =>
      resolve(err ? null : parseActiveApp(stdout)),
    );
  });
}
