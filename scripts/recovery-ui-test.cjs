// Isolated renderer integration check; no real chat or task data is used.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

app.setPath('userData', process.env.JARVIN_TEST_DATA);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: false } });
  try {
    const html = `<!doctype html><button id="taskChip"></button><button id="tasksBtn"></button><dialog id="tasksDlg"><input id="tkRoutineName"><textarea id="tkRoutineSteps"></textarea><button id="tkRoutineSave"></button><button id="tkRoutineCancel"></button><span id="tkRoutineEdit"></span><div id="tkRoutines"></div><input id="tkReminderText"><input id="tkReminderWhen"><select id="tkReminderRepeat"></select><button id="tkReminderCancel"></button><button id="tkReminderAdd"></button><div id="tkReminders"></div><button id="tkClose"></button><button id="tkClearRuns"></button><div id="tkRecovered"></div><div id="tkPaused"></div><div id="tkQueue"></div><button id="tkSendNext"></button><button id="tkClearQ"></button><input id="tkCmd"><button id="tkRun"></button><button id="tkClearJobs"></button><div id="tkJobs"></div><pre id="tkOut"></pre></dialog>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const bundle = fs.readFileSync(process.env.JARVIN_UI_BUNDLE, 'utf8');
    await win.webContents.executeJavaScript(bundle);
    const check = `
      (async () => {
        let records = [{ id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state:'interrupted', request:'Review <b>untrusted</b> input', requestTruncated:false, workspace:'test', sessionId:'s', model:'qwen', hadImages:false, startedAt:1, updatedAt:2, tools:[{id:'1', name:'write_file', state:'requested'}] }];
        let reviewed = 0, sent = 0, dismissed = 0;
        const api = {
          jobsList: async () => [], onJobs: () => () => {}, onRoutineDue: () => () => {}, remindersList: async () => [], onReminders: () => () => {}, routinesList: async () => [], interruptedRuns: async () => records,
          dismissRun: async id => { dismissed++; records = records.filter(r => r.id !== id); },
          clearFinishedRuns: async () => 0,
        };
        const wait = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('UI timed out'); };
        window.confirm = () => true;
        TasksUiBundle.createTasksUi(api, { toast: () => {}, openPreview: () => {}, sendQueued: () => { sent++; }, reviewRun: () => { reviewed++; return true; } }).wire();
        await wait(() => document.getElementById('taskChip').textContent.includes('1 to review'));
        document.getElementById('taskChip').click();
        await wait(() => document.querySelector('#tkRecovered button[data-a="review"]'));
        if (document.querySelector('#tkRecovered b')) throw Error('Untrusted title was rendered as HTML');
        document.querySelector('#tkRecovered button[data-a="review"]').click();
        if (reviewed !== 1 || sent !== 0 || document.getElementById('tasksDlg').open) throw Error('Review ran work or failed to close');
        document.getElementById('taskChip').click();
        await wait(() => document.querySelector('#tkRecovered button[data-a="dismiss"]'));
        document.querySelector('#tkRecovered button[data-a="dismiss"]').click();
        await wait(() => dismissed === 1 && document.getElementById('tkRecovered').textContent.includes('No interrupted'));
        document.getElementById('tkClose').click();
        return 'Recovery UI reviewed and dismissed a test record without running it.';
      })()
    `;
    console.log(await win.webContents.executeJavaScript(check));
    win.destroy(); app.quit();
  } catch (error) { console.error(error); if (!win.isDestroyed()) win.destroy(); app.exit(1); }
}).catch((error) => { console.error(error); app.exit(1); });
