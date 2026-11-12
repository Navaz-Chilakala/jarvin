import test from 'node:test';
import assert from 'node:assert/strict';
import { matchWake, parseVoiceCommand, scrollVoiceDestination, speakable, voiceApproval } from '../src/shared/voicecmd';
import { resolveSpokenFile } from '../src/shared/voice';

const t = (s: string) => parseVoiceCommand(s)?.type ?? null;

test('basic commands match whole utterances, with punctuation and politeness ignored', () => {
  assert.equal(t('Stop.'), 'stop');
  assert.equal(t('  send it! '), 'send');
  assert.equal(t('Hey Jarvin, please stop'), 'stop');
  assert.equal(t('Jarvis, stop everything'), 'stopAll');
  assert.equal(t('Hey Jarvin, cancel all tasks'), 'stopAll');
  assert.equal(t('New chat'), 'newChat');
  assert.equal(t('Undo that.'), 'undo');
  assert.equal(t("Scratch that"), 'clear');
  assert.equal(t('scroll down'), 'scroll');
  assert.equal(t('open settings'), 'openSettings');
  assert.equal(t('next tab'), 'nextTab');
});

test('scroll goes to the active app while explicit chat scrolling stays in Jarvin', () => {
  const scroll = parseVoiceCommand('scroll down');
  const chat = parseVoiceCommand('scroll the chat up');
  assert.deepEqual(scroll, { type: 'scroll', dir: 'down' });
  assert.deepEqual(chat, { type: 'scrollChat', dir: 'up' });
  if (!scroll || scroll.type !== 'scroll' || !chat || chat.type !== 'scrollChat') throw new Error('Invalid command');
  assert.equal(scrollVoiceDestination(scroll, false), 'desktop');
  assert.equal(scrollVoiceDestination(scroll, true), 'chat');
  assert.equal(scrollVoiceDestination(chat, false), 'chat');
  assert.equal(scrollVoiceDestination(chat, true), 'chat');
  assert.deepEqual(parseVoiceCommand('scroll down three steps'), { type: 'scroll', dir: 'down', amount: 3 });
  assert.deepEqual(parseVoiceCommand('scroll up zero steps'), { type: 'scroll', dir: 'up', amount: 0 });
});

test('commands inside longer dictation are NOT commands', () => {
  assert.equal(t('please stop the server when the tests finish'), null);
  assert.equal(t('send an email to the team about the release'), null);
  assert.equal(t('add a clear button to the form'), null);
  assert.equal(t('new chat window should open in a modal'), null);
  assert.equal(t('undo the changes in the config parser and rerun'), null);
  assert.equal(t(''), null);
});

test('approve and deny: risky approvals need the longer phrase', () => {
  assert.deepEqual(parseVoiceCommand('approve'), { type: 'approve', risky: false });
  assert.deepEqual(parseVoiceCommand('Approve command.'), { type: 'approve', risky: true });
  assert.deepEqual(parseVoiceCommand("don't allow"), { type: 'deny' });
  assert.equal(parseVoiceCommand('yes'), null, 'a bare yes never approves anything');
  assert.equal(parseVoiceCommand('okay'), null);
  assert.equal(parseVoiceCommand('always allow'), null, 'there is deliberately no voice "always allow"');
});

test('open file and edit-by-voice', () => {
  assert.deepEqual(parseVoiceCommand('Open server dot ts'), { type: 'openFile', name: 'server dot ts' });
  assert.deepEqual(parseVoiceCommand('open the file app.py'), { type: 'openFile', name: 'app py' });
  assert.equal(t('open the terminal'), null);
  assert.equal(t('open the sidebar'), null);
  assert.deepEqual(parseVoiceCommand('Make this shorter.'), { type: 'edit', instruction: 'Make this shorter.' });
  assert.equal(t('rename this function to load user'), 'edit');
  assert.equal(t('explain this'), 'edit');
  assert.equal(t('make it more formal'), 'edit');
  assert.equal(t('translate that to Spanish'), 'edit');
  assert.equal(t('make a new component for the header with a logo and menu and a search box'), null);
});

test('wake word tolerates common mishearings', () => {
  assert.equal(matchWake('Hey Jarvin, open settings'), 'open settings');
  assert.equal(matchWake('hey jarvis what changed today'), 'what changed today');
  assert.equal(matchWake('Jarvin'), '');
  assert.equal(matchWake('Okay Garvin stop'), 'stop');
  assert.equal(matchWake('hello jervin run the tests'), 'run the tests');
  assert.equal(matchWake('hey there how are you'), null);
  assert.equal(matchWake('the service is down'), null);
  assert.equal(matchWake('Jarvik says hi'), null);
  assert.equal(matchWake('hejarvin open settings'), 'open settings');
  assert.equal(matchWake('hey jar vin run the tests'), 'run the tests');
  assert.equal(matchWake('they are running late'), null);
  assert.equal(matchWake('hey jarring noise outside'), null);
  assert.equal(matchWake('Hey Travis, open settings'), 'open settings');
  assert.equal(matchWake('hey Martin open settings'), null);
  assert.equal(matchWake('Travis open settings'), null);
  assert.equal(matchWake(''), null);
});

test('speakable strips markup and keeps whole sentences', () => {
  const md = '## Done\n\nI fixed the **bug** in `app.py`. See [docs](https://x.y/z) for more.\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- first point\n- second point';
  const s = speakable(md, 400);
  assert.equal(s, 'Done I fixed the bug in app.py. See docs for more. first point second point');
  assert.ok(!/[`*|#]|http/.test(s));
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const cut = speakable(long, 100);
  assert.ok(cut.length <= 100 && cut.endsWith('.'));
});

test('plain "approve" only allows edits and searches; commands need "approve command"', () => {
  const plain = parseVoiceCommand('approve') as { type: 'approve'; risky: boolean };
  const phrase = parseVoiceCommand('approve command') as { type: 'approve'; risky: boolean };
  assert.equal(plain.risky, false);
  assert.equal(phrase.risky, true);
  assert.equal(voiceApproval(plain, 'write_file'), 'allow');
  assert.equal(voiceApproval(plain, 'edit_file'), 'allow');
  assert.equal(voiceApproval(plain, 'run_command'), 'needs-phrase');
  assert.equal(voiceApproval(plain, 'mcp__github__create_issue'), 'needs-phrase');
  assert.equal(voiceApproval(plain, 'web_fetch'), 'needs-phrase');
  assert.equal(voiceApproval(phrase, 'run_command'), 'allow');
});

test('a bare "yes" or "ok" never counts as approval', () => {
  for (const w of ['yes', 'yeah', 'ok', 'okay', 'sure', 'go ahead', 'do it', 'always allow', 'yes always']) assert.equal(t(w), null, w);
});

test('spoken file names resolve to one workspace file', () => {
  const files = ['app.py', 'src/server.ts', 'src/utils/server.test.ts', 'README.md', 'docs/read me notes.txt', 'src/a/index.ts', 'src/b/index.ts'];
  assert.equal(resolveSpokenFile(files, 'app dot py'), 'app.py');
  assert.equal(resolveSpokenFile(files, 'app py'), 'app.py');
  assert.equal(resolveSpokenFile(files, 'the server dot ts'), 'src/server.ts');
  assert.equal(resolveSpokenFile(files, 'read me'), 'README.md');
  assert.equal(resolveSpokenFile(files, 'readme'), 'README.md');
  assert.equal(resolveSpokenFile(files, 'index dot ts'), null); // ambiguous
  assert.equal(resolveSpokenFile(files, 'nothing here'), null);
  assert.equal(resolveSpokenFile(files, ''), null);
});

test('open-file commands, tab and settings commands parse', () => {
  assert.deepEqual(parseVoiceCommand('Open app dot py'), { type: 'openFile', name: 'app dot py' });
  assert.equal(t('next tab'), 'nextTab');
  assert.equal(t('close settings'), 'closeSettings');
  assert.equal(t('scroll down'), 'scroll');
  assert.equal(t('confirm'), 'confirm');
  assert.equal(t('open settings'), 'openSettings');
});

test('the name is found after a filler word, but not in the middle of a sentence', () => {
  assert.equal(matchWake('um Jarvin, open Notepad'), 'open Notepad');
  assert.equal(matchWake('so, Jarvin open the calculator'), 'open the calculator');
  assert.equal(matchWake('I told Jarvin to open Notepad'), null);
  assert.equal(matchWake('Jarvin'), '');
});

test('the name is recognised the way recognizers write it in different accents, and when split in two', () => {
  for (const heard of ['Jarwin', 'Charvin', 'Darvin', 'Javin', 'Jarven', 'Jarbin', 'Jarvan', 'Jervin', 'Garvin', 'Jarvis', 'Jarvind'])
    assert.equal(matchWake(`${heard}, open the calculator`), 'open the calculator', heard);
  for (const heard of ['Jar vin', 'Jar win', 'Java in', 'Char win', 'Hey jar vin'])
    assert.equal(matchWake(`${heard} open the calculator`), 'open the calculator', heard);
  for (const other of ['Open the calculator', 'Marvin is here', 'Jar of honey please', 'Charge the phone', 'Give me a minute', 'Java is a language'])
    assert.equal(matchWake(other), null, other);
});
