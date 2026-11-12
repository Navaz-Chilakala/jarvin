// Isolated renderer integration check: a hidden Electron window and an in-memory API.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

app.setPath('userData', process.env.JARVIN_TEST_DATA);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: false } });
  try {
    const html = '<!doctype html><button id="memoryBtn"></button><dialog id="memoryDlg"><button id="memoryClose"></button><select id="memorySelect"></select><textarea id="memoryText"></textarea><div id="memoryStatus"></div><div id="memoryMeta"></div><button id="memorySave"></button><button id="memoryDelete"></button></dialog>';
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const bundle = fs.readFileSync(process.env.JARVIN_UI_BUNDLE, 'utf8');
    const check = `
      (async () => {
        let value = 'Original'; let revision = 'one'; let exists = true;
        const api = {
          memoryList: async () => exists ? [{ id: 'one', name: 'Preference', description: 'Test', type: 'user' }] : [],
          memoryRead: async () => ({ text: value, revision }),
          memorySave: async (_id, expected, text) => { if (expected !== revision) throw Error('stale'); value = text; revision = 'two'; },
          memoryDelete: async (_id, expected) => { if (expected !== revision) throw Error('stale'); exists = false; },
        };
        const wait = async (test) => { for (let i = 0; i < 100; i++) { if (test()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('UI timed out'); };
        window.confirm = () => true;
        MemoryUiBundle.createMemoryUi(api).wire();
        document.getElementById('memoryBtn').click();
        await wait(() => document.getElementById('memoryText').value === 'Original');
        const editor = document.getElementById('memoryText');
        editor.value = 'Updated'; editor.dispatchEvent(new Event('input', { bubbles: true }));
        if (document.getElementById('memorySave').disabled) throw Error('Save not enabled');
        document.getElementById('memorySave').click();
        await wait(() => document.getElementById('memoryStatus').textContent === 'Memory saved.');
        if (value !== 'Updated') throw Error('Save failed');
        document.getElementById('memoryDelete').click();
        await wait(() => !exists && document.getElementById('memorySelect').options.length === 0);
        return 'Memory UI opened, loaded, saved and deleted a test memory.';
      })()
    `;
    await win.webContents.executeJavaScript(bundle);
    console.log(await win.webContents.executeJavaScript(check));
    win.destroy();
    app.quit();
  } catch (error) {
    console.error(error);
    if (!win.isDestroyed()) win.destroy();
    app.exit(1);
  }
}).catch((error) => { console.error(error); app.exit(1); });
