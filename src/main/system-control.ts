import { execFile } from 'node:child_process';

export const SYSTEM_ACTIONS = ['volume_up', 'volume_down', 'mute', 'volume_set', 'brightness_up', 'brightness_down', 'brightness_set', 'dark_mode', 'light_mode', 'lock_screen'] as const;
export type SystemAction = (typeof SYSTEM_ACTIONS)[number];

const KEY_TYPE = `Add-Type -Namespace J -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'`;
const press = (vk: number, times: number) => `1..${times} | ForEach-Object { [J.K]::keybd_event(${vk},0,0,[UIntPtr]::Zero); [J.K]::keybd_event(${vk},0,2,[UIntPtr]::Zero); Start-Sleep -Milliseconds 15 }`;
const GET_BRIGHT = `(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness`;
const setBright = (n: number) => `Invoke-CimMethod -InputObject (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1) -MethodName WmiSetBrightness -Arguments @{Timeout=1;Brightness=${n}} | Out-Null`;
const theme = (light: 0 | 1) => `$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'; Set-ItemProperty -Path $k -Name AppsUseLightTheme -Value ${light}; Set-ItemProperty -Path $k -Name SystemUsesLightTheme -Value ${light}`;

/** Builds the PowerShell for one action. Only whitelisted actions and clamped integers are ever placed in the script. */
export function buildSystemScript(action: string, amount?: unknown): { script: string; says: string } {
  const pct = (fallback: number) => { const n = Number(amount); return Math.min(100, Math.max(0, Math.round(Number.isFinite(n) && amount !== undefined && amount !== null ? n : fallback))); };
  switch (action as SystemAction) {
    case 'volume_up': { const n = pct(10); return { script: `${KEY_TYPE}; ${press(0xAF, Math.max(1, Math.round(n / 2)))}`, says: `Raised the volume by about ${n}%.` }; }
    case 'volume_down': { const n = pct(10); return { script: `${KEY_TYPE}; ${press(0xAE, Math.max(1, Math.round(n / 2)))}`, says: `Lowered the volume by about ${n}%.` }; }
    case 'mute': return { script: `${KEY_TYPE}; ${press(0xAD, 1)}`, says: 'Toggled mute.' };
    case 'volume_set': { const n = pct(50); return { script: `${KEY_TYPE}; ${press(0xAE, 50)}; ${n >= 2 ? press(0xAF, Math.round(n / 2)) : ''}`, says: `Set the volume to about ${n}%.` }; }
    case 'brightness_up': { const n = pct(10); return { script: `$b = ${GET_BRIGHT}; $n = [Math]::Min(100, $b + ${n}); ${setBright(0).replace('Brightness=0', 'Brightness=$n')}; "Brightness is now $n%"`, says: '' }; }
    case 'brightness_down': { const n = pct(10); return { script: `$b = ${GET_BRIGHT}; $n = [Math]::Max(0, $b - ${n}); ${setBright(0).replace('Brightness=0', 'Brightness=$n')}; "Brightness is now $n%"`, says: '' }; }
    case 'brightness_set': { const n = pct(50); return { script: `${setBright(n)}; "Brightness is now ${n}%"`, says: '' }; }
    case 'dark_mode': return { script: theme(0), says: 'Switched Windows to dark mode.' };
    case 'light_mode': return { script: theme(1), says: 'Switched Windows to light mode.' };
    case 'lock_screen': return { script: `rundll32.exe user32.dll,LockWorkStation`, says: 'Locked the screen.' };
    default: throw new Error(`Unsupported system action. Use one of: ${SYSTEM_ACTIONS.join(', ')}.`);
  }
}

export function runSystemAction(action: string, amount?: unknown): Promise<string> {
  const { script, says } = buildSystemScript(action, amount);
  if (process.platform !== 'win32') return Promise.reject(new Error('System controls only work on Windows.'));
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(action.startsWith('brightness') ? 'Brightness could not be changed (an external monitor or a desktop PC may not support it).' : String(stderr || err.message).trim().slice(0, 200)));
      resolve(says || String(stdout).trim() || 'Done.');
    });
  });
}
