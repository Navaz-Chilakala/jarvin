# JARVIS implementation tracker

This tracker covers the supplied Project JARVIS master brief. It describes the existing Electron/TypeScript app in this repository, not the separate incomplete Python scaffold in the parent directory. A checked item requires an end-to-end acceptance test on the target Windows machine; unit tests or the presence of code alone are not enough.

## Status board (12 November 2026, evening)

Automated suite: 347 tests, 339 pass, 8 skipped, 0 fail; typecheck and build clean (re-run for this update).

How to read this: **Live** means it was run in the real app on the Windows laptop. **Checked** means an automated or isolated check passed. **Built** means the code exists and unit tests pass, but nobody has run it for real. Each line says which.

### Where things stand in one paragraph

Jarvin runs as a Windows Electron app with a TypeScript main process and renderer. On 12 November the user completed the voice test on 20 recordings. Qwen3-ASR had 3 word errors out of 160 (1.9%), 17 exact sentences and 9 of 10 wake phrases recognized, averaging 1.49 seconds per recording. The three other recognizers failed while loading their shared speech engine. A four-way accuracy comparison remains open.

### 1. Voice

**How it behaves today**

| What | State |
|---|---|
| Microphone is off until switched on, by the "Mic off / Listening" button in the main window or the round mic button on the floating pet (grey with red slash = off, green ring = on). | **Live by the user (11 Nov): basic flow works.** A click on the pet's button was not reported. |
| "Hey Jarvin" is required (user decision, 12 Nov). With the mic on, Jarvin acts only on speech that starts with "Hey Jarvin", "Jarvin" or "Jarvis". Everything else is ignored and noted quietly in the voice status line. No name-free window after a reply; a loud sound no longer cuts Jarvin's voice. The name alone keeps Jarvin waiting 10 s for the request. | Checked with generated speech on Whisper base and distil-small: "Hey Jarvis, …" and "Jarvin, …" run with the name removed; name, pause, request runs; plain speech is ignored. **Not tried with the user's voice.** The saved settings file still shows the wake word off; it is switched on once at the next start (`voice.wakeVersion`). |
| While Jarvin is doing a task (a tool has been used), only "stop", "cancel", "wait", "pause", "be quiet", "enough" interrupt it. | Checked with generated speech (`node scripts/voice-stop-e2e.mjs`): an unrelated sentence was ignored while the task ran, "Stop that." ended it. Not run on a real task with the user's voice. The voice log now says what happened to each sentence (fixed 12 Nov, night): "Heard …" and then one of "→ running it", "→ ignored: a task is running. Say "stop" to interrupt it", "→ stopping the task", "→ ignored: that was my own voice". Seen in the `voice-stop-e2e.mjs` run. |
| Bare "stop" is obeyed without the name. | Checked as part of the stop check above. |
| End of speech is judged against the speaker's own loudness, so steady music or TV does not hold a request open to the 12 s cap. | Built, unit-tested. Not measured in a noisy room. |
| The name is matched by sound (Jarwin, Charvin, Javin, "Jar vin"). A repeated bare "Jarvin" no longer gets sent to the model as a request. | Checked with generated speech (`--hey`, `--wake`, `--wake-pause`). Cost: a sentence starting with Gavin, Devin or Darwin also matches. |
| Recognizer: Qwen3-ASR, now given the expected words "Jarvin, Hey Jarvin, stop". When Windows blocks its engine, Jarvin falls back to distil-small.en, then whisper-base.en, then moonshine. | **Measured on the user's voice (12 Nov):** Qwen3-ASR with the hint gets 1 word wrong in 160 and hears the wake phrase 10 times in 10. The fallback distil-small.en gets 13 wrong in 160 and hears the wake phrase 4 times in 10. This explains "I say one thing, it hears another": on launches where Windows blocks Qwen, Jarvin was silently using the fallback. The block itself is not fixed; it is now announced loudly. |
| Spoken replies: Piper "joe" ships inside the app; the worker falls back from Kokoro to Piper when Kokoro's engine is blocked. | Checked (`npm run check:natural-voice`). Not listened to through speakers. |

**Making it reliable ([VOICE-DESIGN.md](VOICE-DESIGN.md))**

| Step | What | State |
|---|---|---|
| Design | Five layers: mic switch, neural voice detector (Silero), a dedicated "hey jarvis" wake-word model (openWakeWord), one named recognizer chosen by test, confidence filtering; a fixed table of turn rules; a fast "stop" path; push-to-talk. | Written 12 Nov. |
| 0 | Voice test: read 20 sentences once; every installed recognizer is scored on those recordings. Settings, Voice, "Voice test: find the best recognizer for my voice". | **Done, live, on the user's voice (12 Nov evening).** The user recorded all 20 sentences. In that first run only Qwen3-ASR completed; distil-small.en, whisper-base.en and Moonshine reported "Speech engine is not installed". Cause: the test loaded them in worker threads while the running app already had the speech libraries loaded in other threads; the real error was being discarded. They now run in their own process and the real error is reported. The comparison was then re-run on the saved recordings (`scripts/voice-test-run.ts`) and all four completed. Results below. Not yet re-run from inside the dialog. |
| 1 | Show the active recognizer; never switch silently; use the winner of step 0. | **Partly built 12 Nov.** Qwen3-ASR is the winner and is already the saved setting. When Windows blocks it and Jarvin falls back, a red warning and a pop-up now say so ("Windows blocked the accurate speech engine this time… will mishear more. Restart Jarvin to try again."). Not seen live. Still missing: the active recognizer named on screen at all times. |
| 2 | Silero voice detector instead of the loudness threshold. | Not built. |
| 3 | Dedicated wake-word model and fast "stop". | Not built. Whether the ready-made "hey jarvis" model fires on "Hey Jarvin" in the user's voice is unknown. |
| 4 | Drop low-confidence and noise-phrase results; show "Heard: …" before acting. | Not built. |
| 5 | Push-to-talk. | Not built. |
| 6 | Re-run the voice test and a 30-minute room test with a count of false triggers. | Not done. |

**Results on the user's own voice (20 recordings, 160 scored words, 12 Nov)**

| Recognizer | Wrong words | Sentences exact | "Hey Jarvin" heard | Time each |
|---|---:|---:|---:|---:|
| Qwen3-ASR with the name hint (now the default) | 1 (0.6%) | 19 of 20 | 10 of 10 | 2.2 s |
| Qwen3-ASR without a hint (as the user first ran it) | 3 (1.9%) | 17 of 20 | 9 of 10 | 1.5 s |
| distil-small.en (the silent fallback) | 13 (8.1%) | 11 of 20 | 4 of 10 | 3.2 s |
| whisper-base.en | 13 (8.1%) | 11 of 20 | 1 of 10 | 1.3 s |
| moonshine-base | 20 (12.5%) | 9 of 20 | 1 of 10 | 0.4 s |

Without the hint Qwen wrote "Hey, Darwin" once, answered "Hey Jarvin, stop" in Chinese characters once, and heard "lock" as "log". Hints tried on the same recordings: none 3 wrong; "Jarvin" 5 wrong; "Hey Jarvin" 3 wrong; "Jarvin,Hey Jarvin,stop" 1 wrong; the last is now the default (`QWEN_HOTWORDS` in `src/main/stt-worker.ts`). The other recognizers wrote the name as "H R VIN", "H. Arvin", "Hedgehogin" and similar. Caution: the hint was chosen and measured on the same 20 recordings, so the real gain may be smaller; whether the hint makes Qwen "hear" the name in noise has not been tested. The recordings stay in `%APPDATA%\jarvin\voice-test` for re-testing.

History of the listening rules, because they changed three times: always listening with the wake word (to 10 Nov); mic switch with no wake word (11 Nov, user tried it, basic flow worked); mic switch plus "Hey Jarvin" (12 Nov, user decision, because stray sound was still being picked up).

### 2. Desktop tasks

| What | State |
|---|---|
| Open or restore apps, new blank document, list/focus/minimize/maximize/restore/snap windows, two apps side by side. | Live (9 Nov). |
| Type exactly (via clipboard), save a document with verification, find and open a user file. | Live (9 and 10 Nov). |
| Chrome search and read results; describe a window or the screen with the vision model; Chrome to Notepad to save. | Live (9 Nov). |
| Volume up/down; "raise then lower the volume" finishes in two calls. | Live (11 Nov). A bug that set the volume about 15 times per run is fixed and confirmed. |
| Calculator sums by pressing buttons by name. Clear is pressed first, "12" is typed as 1 then 2, the window is brought forward, and the reply leads with what the display shows. | Live (11 Nov, qwen3:8b): 7 x 8 = 56, 9 x 6 = 54, 125 + 375 = 500, 12 x 12 = 144, 900 - 125 = 775, last run 8 s. On a cold start the first click can fail once and Jarvin recovers; the wait was lengthened after that and not re-run. |
| No screenshot after every action. | Live once: the Calculator task used no screenshots. Not measured across other tasks. |
| Clipboard, selected text, more shortcuts, brightness, dark/light mode, lock screen, visual click/type, tab and window traversal. | Built. Not run live. |

### 3. Documents

| What | State |
|---|---|
| Create Word, Excel, PowerPoint and PDF files; edit Word and PowerPoint by replacing a phrase; write Excel cells; read text from images and scanned PDFs (offline English OCR). | Checked in isolation (`node scripts/office-check.cjs`): each format created, edited where supported, read back; image and PDF page recognised. |
| Word through the real agent. | **Live (12 Nov, qwen3:8b):** "create a Word document … with the heading Shopping and three lines" made the file in one call with the right text. The heading is a plain line, not a Word heading style. |
| Excel through the real agent. | **Live (12 Nov), after a fix.** The first run put the whole table in cell A1, because the model sent backslash-t instead of tabs, and Jarvin reported success anyway. Now escaped tabs, commas and pipe tables become real rows and columns, and the tool reports the shape ("3 rows x 2 columns"). Re-run: six cells, A1 to B3, correct. |
| PowerPoint and PDF through the real agent. | Not tried. |
| Limits. | Creation refuses an existing file. Word and PowerPoint edits need a unique phrase inside one formatted run. Excel values are stored as text. PDF can be created, not edited. |
| Reading PDF, Word, CSV, Excel, PowerPoint. | PDF and Word extraction checked earlier with the real app's runtime; the others built. |

### 4. Speed

| What | State |
|---|---|
| Follow-up requests: the clock moved out of the system prompt and helper calls stopped reloading the model. | Live (10 Nov, qwen3:8b, 97 tools): 0.3 s of model time, was 10 to 18 s. |
| First request after start-up: chat model warmed last, and the everyday desktop prompt is read into the model's cache at start-up. | Live (11 Nov): 2.3 s, was 10.3 s the day before and 20 to 41 s before that. |
| Screen-reading steps on qwen3:8b. | **Still slow, not fixable in code:** 15 to 18 s per step, because qwen3:8b and the vision model do not fit in 8 GB VRAM together. qwen3.5:4b takes 2.2 to 3.4 s. Table under "Known problems". The user chose to keep qwen3:8b. |
| Speech recognition time per sentence (CPU). | Measured 12 Nov: moonshine-base 0.2 to 0.7 s, whisper-base.en and Qwen3-ASR about 1.3 to 1.7 s, distil-small.en 3.2 to 3.6 s. Running Whisper on the GPU through DirectML crashed in one try. |

### 5. Staying alive and picking work back up

| What | State |
|---|---|
| Window reloads after its renderer crashes (at most 3 times in 10 minutes). | Live (11 Nov): crashed on purpose, reloaded, UI came back. |
| A task cut off by a crash continues once after restart; a normal quit marks it paused instead. | Live (11 Nov): app killed mid-task, task resumed and finished, next restart started nothing. |
| Restart after the whole app dies. | Checked in an isolated profile (`node scripts/crash-restart-e2e.mjs`): killing the main process produced a fresh instance with a working UI; Quit from the pet closed it; at most three restarts in ten minutes. |
| Start at sign-in, hidden, with mic and models waiting until first opened; tray icon (Open, mute, pause observation, Quit); catch-up of reminders and routines after sleep or unlock. | Hidden start checked in a temporary profile. Sign-in entry, tray menu and sleep catch-up: built, not exercised. The setting is off on this PC. |

### 6. Reminders, routines, proactive notices

| What | State |
|---|---|
| One-time reminders with a Windows scheduled-task backup; task list; background commands. | Checked in isolated Electron. Native notification not confirmed by eye. |
| Daily and weekly reminders, editing a pending reminder, snoozing a due one. | Checked in the real Tasks panel with a temporary profile (`npm run check:recovery-e2e`): daily created, edited to weekly, restarted overdue, snoozed ten minutes, next weekly date kept. |
| Routines: optional "every day at HH:MM"; "Step by step" runs each step as its own request. | Checked (unit tests, isolated routine UI check). No scheduled run has fired live. |
| Proactive notices (off by default, and off on this PC): low-battery warning at 20% unplugged; due reminders said aloud; quiet hours; 4 spoken per hour; never acts. | Spoken reminder **live (11 Nov)**: shown and audio started; not checked by ear. Battery reading checked in the real app on 12 Nov (night): Jarvin read 84% and charging, matching Windows. The warning itself cannot fire while plugged in above 20%, so it was not seen on hardware: to see it, switch notices on, unplug and let the battery fall to 20%. |
| Optional notices for a finished model download, a finished or failed background command, and a reminder containing “meeting” within ten minutes. | Checked on Windows in isolated Electron. A real background command, meeting reminder and Ollama pull each produced the expected toast. |

### 7. The pet, the icon and the look

| What | State |
|---|---|
| Pet is a 3D-rendered cream plush with headphones and a chest heart, generated as Jarvin's own character. Used for the floating pet, the main-window portrait and chat avatar, and the app icon. | Built 10 and 11 Nov from full-size renders (`assets/pet-source`, `scripts/cutout-pet.cjs`, `scripts/make-icon.cjs`). Seen as still captures. |
| Four poses swapped by state: standing (idle), waving (speaking), hand on headphone (listening), hand at chin (working). | **Checked in the real app, 12 Nov (night):** each state loaded its own picture and movement (idle `pet.png`/float, working `pet-think.png`/think, speaking `pet-wave.png`/talk, listening `pet-listen.png`/listen), with a capture of each. Not watched by a person. |
| Round microphone button on the pet. | **Checked in the real app with the real microphone, 12 Nov (night):** the button said "Microphone is off. Click to turn it on."; one click switched the microphone on and the pet showed listening; a second click switched it off. |
| Desktop, Start-menu and folder shortcuts show the new icon. | Re-saved 11 Nov; Windows returns the new icon. Not looked at on the desktop itself. |

### 8. Packaging and code health

| What | State |
|---|---|
| Zip build `release\Jarvin-0.1.0-win.zip`, 322 MB, built 12 Nov 21:42. | **Current.** Built from the 21:41 build output, which contains the first-button-press fix, the "Mic off" label, the voice test, the name hint, the weaker-engine warning and the truthful voice log. Unzipped to a temp folder and started: the main window opened. Nothing else was clicked in the unzipped copy; the voice checks were run against the source build, not this package. |
| Setup .exe installer. | Smart App Control blocked the local NSIS build. **The GitHub installer job works:** the manual run of 12 Nov (14:52 UTC) built the Setup .exe and kept it as the `jarvin-installer` artifact (272 MB, unsigned). The same run's `build` job failed on 6 unit tests, all for one reason: the runner's temp folder is a short `RUNNER~1` path and the path tests compare it with the long form. Fixed in `.github/workflows/ci.yml` by pointing TEMP/TMP at the runner's own temp folder for the test step. **Pushed 12 Nov (night, commit bb42c16) and the `build` job passed on GitHub** (run 43253210872: typecheck, unit tests and build all green). The installer was not downloaded or installed: this PC blocks unsigned installers, so a clean-install check needs a PC without Smart App Control or a signed build. Signing needs a bought certificate. |
| Renderer `init()` split from 771 lines to about 110. | Checked by the recovery, assistant and memory UI checks. Terminal panel and settings dialog not clicked through. |
| Check scripts. | `handsfree-e2e.mjs` (variants `--stronger`, `--widget`, `--interrupt`, `--hey`, `--wake`, `--wake-pause`, `--barge`, `--qwen`), `voice-stop-e2e.mjs`, `voice-test-e2e.mjs`, `office-check.cjs`, `crash-restart-e2e.mjs`, `recovery-e2e.mjs`, `assistant-ui-e2e.mjs`. All passed on their last run on 12 Nov; `--qwen` passes only when Windows lets the engine load, and `--barge` is expected to send nothing now that the name is required. |

### Known problems on this PC
- **Smart App Control blocks unsigned files, and not consistently.** It blocks the NSIS setup stub, so a Setup .exe can be neither built nor run here (the zip is the working build). It also blocks parts of the sherpa-onnx engine behind Qwen3-ASR and Kokoro on some launches and not on others: `sherpa-onnx.node` from 10 Nov 18:17 to 22:35, loading again on 12 Nov, `sherpa-onnx-c-api.dll` blocked at 08:43 on 12 Nov, the Qwen check passing minutes later. So which recognizer Jarvin uses varies from session to session. The lasting fix is code signing; the design in VOICE-DESIGN.md avoids depending on it.
- **qwen3:8b is slow for screen tasks.** Measured per screen step (one vision call plus the next chat step, direct Ollama calls, synthetic screenshots):

  | Setup | Per screen step |
  |---|---|
  | qwen3:8b + qwen3-vl, both on GPU (current setting) | 15 to 18 s |
  | qwen3:8b at 8K context + qwen3-vl | 15 to 16 s |
  | qwen3:8b + qwen3-vl on CPU | 42 s |
  | qwen3.5:4b + qwen3-vl | 3.1 to 3.4 s |
  | qwen3.5:4b for chat and vision | 2.2 to 2.5 s |

  qwen3.5:4b's own vision quality was not compared with qwen3-vl, and it stalled more often than qwen3:8b in earlier runs.
- The thinking pose of the pet has a slight frown.
- Calculator windows opened by the 11 Nov tests were left open.

### Matched model runs on 11 November

Both installed chat models completed all four requests. Times are elapsed seconds from one run per task on this laptop. The first run for each model can include model loading.

| Task | qwen3:8b | qwen3.5:4b |
|---|---:|---:|
| Edit one word and preserve the rest of the file | 2.27 | 10.73 |
| Create a five-minute reminder | 1.60 | 1.29 |
| Copy the file with exact content | 1.60 | 1.88 |
| Click the blue button on a generated screen and verify the new result with qwen3-vl | 29.69 | 20.60 |

The file and reminder trials used the agent loop, four available tools and temporary workspace data. The visual trial used simulated input. Reproduce with `scripts/model-task-comparison.ts` and `scripts/live-visual-agent.ts` (set `JARVIN_TEST_CHAT_MODEL`). On 12 November the user chose to keep `qwen3:8b`.

### Settings on this PC right now
Chat model qwen3:8b; vision model qwen3-vl:4b-instruct; speech recognizer Qwen3-ASR (with the silent fallback described above); microphone off at start; proactive notices off; start at sign-in off.

### Still to do
1. **User: restart Jarvin and try by voice** with the name hint in place. Report whether the red "weaker speech engine" warning appears and how requests are heard. (The three loader failures are diagnosed and fixed, and the comparison was repeated on the 20 clips: see the results table in section 1.)
2. Stop the weaker recognizer taking over at all: retry loading the accurate engine at start-up (untested stopgap), then code signing (lasting fix).
3. Voice steps 1 to 6 of VOICE-DESIGN.md, in order.
4. ~~Rebuild the zip and push the late-night fixes.~~ Done 12 Nov 21:42.
5. ~~Fix the misleading "running it" line in the voice log.~~ Done 12 Nov (night).
6. Try PowerPoint and PDF creation through the real agent.
7. Battery reading checked (84%, charging, matches Windows). Left for the user: see the warning fire at 20% unplugged, and listen to a notice. The download, background command and meeting toasts were observed in an isolated Electron profile with a real Ollama pull.
8. Pet mic button and pet poses checked in the real app (12 Nov, night). Left for the user, because they need a voice and ears: say "stop" during a real task, hear the Piper voice, the wider live checklist further down this file.
9. Installer CI: the installer job builds the Setup .exe. The test-step fix is pushed and the `build` job is green (12 Nov, night). Left: try the installer on a PC without Smart App Control, and signing (needs a certificate).

### Dropped or out of scope
- Wi-Fi, Bluetooth and Do Not Disturb switches (dropped by the user; a Wi-Fi/Bluetooth version was built and removed on 10 Nov).
- Browser control through the extension (dropped by the user for now).
- A real Windows service (replaced by background mode; reasons in [SERVICE-DESIGN.md](SERVICE-DESIGN.md)).
- Always-on listening (replaced on 11 Nov by the microphone switch).
- Privacy gap for shell and MCP tools (deliberately skipped for now).
- Phone controller.

### Day log
- **13 Nov:** feature work paused at the user's request. Wrote [JARVIN-TECHNICAL-GUIDE.md](JARVIN-TECHNICAL-GUIDE.md): an end-to-end technical guide (concepts from first principles, then architecture, request flow, agent loop, tools, voice, desktop control, safety, recovery, build and limits) with eight diagrams, all checked to render. Facts were read from the code; not committed yet. An 18-slide presentation of the same material was made as a private slide deck (https://claude.ai/artifact/WkmsNhYGsnHYT4Us3iQnnw); its layout was not checked slide by slide.
- **9 Nov:** first live desktop runs with qwen3.5:4b; launch, typing, save, Chrome, Calculator; many small fixes (see "Live desktop findings" below).
- **10 Nov:** auto-resume, installer diagnosis and zip build, prompt caching and warm order, speech and voice fallbacks, fewer-screenshot wording, bundled voice, routine schedule and step mode, renderer split, proactive notices, background mode, new plush pet and icon.
- **11 Nov:** prompt priming, volume loop confirmed fixed, voice check scripts repaired, crash reload and auto-resume confirmed live, pet poses, listening reworked twice (first around the wake word, then to an explicit microphone switch), Calculator answers fixed, zip rebuilt, reminder repeat/edit/snooze, more proactive notices, restart after a full crash, matched model runs.
- **12 Nov, morning:** document tools checked in isolation (`office-check.cjs`) and then through the real agent; the Excel one-cell bug found and fixed; the "only stop interrupts a task" rule checked; "Hey Jarvin" made required again at the user's request, and a bug that sent a repeated "Jarvin" as a request fixed; zip rebuilt at 08:38.
- **12 Nov, later:** the user reported that Jarvin often hears the wrong words. Cause investigated (intermittent Windows block of the speech engine, name misheard by fallback models, loudness-only speech detection, no measurement on the user's voice); recognizer speeds measured; VOICE-DESIGN.md written; the voice test (step 0) built and checked end to end with generated speech. Tracker rewritten in the evening.
- **12 Nov, evening:** the user recorded the 20 sentences and ran the voice test. Three recognizers failed to load inside the app (fixed: they run in their own process now, and the real load error is reported). Comparison re-run on the saved recordings: Qwen3-ASR far ahead of the three others on the user's voice. A name hint ("Jarvin,Hey Jarvin,stop") cut Qwen's mistakes from 3 to 1 in 160 words and made the wake phrase 10 of 10; it is now the default. A loud warning was added for the sessions where Windows blocks Qwen and the weaker recognizer takes over. 347 tests pass; the Qwen voice check and the voice-test check pass. Not yet tried live by voice with the hint. Next: stop the fallback happening at all (code signing is the lasting fix; retrying the engine load at start-up is an untested stopgap).
- **12 Nov, night:** voice log made truthful (it says whether a heard sentence was run, ignored or used to stop). In the real app: battery reading correct, the pet's mic button switches the real microphone on and off, all four pet poses load with their movement. CI looked at: installer job already builds the Setup .exe; the test job failed on short temp paths, fixed in the workflow, not pushed. Zip rebuilt (see section 8). Later the same night: CI fix and voice changes pushed (commit bb42c16), `build` job green.
- **12 Nov, late night, promo material:** pictures, two videos (landscape for LinkedIn, vertical for WhatsApp) and post texts made in `promo/` (not committed). The video contains a real screen recording of "Open Calculator and work out 12 times 12" in a clean profile with qwen3:8b: two steps, Calculator showed 144. Two bugs found while recording and fixed: (1) **the first button press after opening an app failed** with "Window reference expired" when the model passed the window as `ApplicationFrameHost Calculator` without quotes (the name match in `windows-uia.ts` was broken; fixed, test added; before the fix 2 of 2 clean-profile runs failed the first press, and one of them answered 144 without pressing anything); (2) the mic button said "Starting mic…" while the mic was off at start (now "Mic off"). 347 tests pass. Both fixes were then pushed (commit 8e02262, `build` job green) and the zip was rebuilt at 21:42 (unzipped, fix and label confirmed inside, main window opened). Pet-only clips added to `promo/` (`jarvin-pet-whatsapp.mp4` vertical, `jarvin-pet-linkedin.mp4` square, 24 s): the pet's own four pictures moved with the same eight movements the floating pet uses (greeting, idle float, listening, thinking, working, speaking, hover wiggle, attention hop). They are composed from the pictures, not a screen capture of the widget. The four videos and seven pictures were pushed to `promo/` in the public repo (commit db79be9). Versions with a soft background track (synthesised for this, not downloaded music; AAC stereo) were written to `C:\Users\NAVAZ\Desktop\jarvinvideos\*-sound.mp4`; Each was checked to decode with picture and audio; the user listened and approved, and they were pushed to `promo/`; the silent versions were then removed from the repo at the user's request (copies remain in the jarvinvideos folder).

## Architecture in use

The interactive Electron main process owns the Ollama client, agent loop, tool registry, permissions, document workers, settings, and task cancellation. The isolated renderer exposes chat, editor, voice controls and approvals via preload/IPC. Document parsing runs in a bounded child process. The voice worker runs separately. The app uses local Ollama by default; network tools access the internet only when invoked. This is a single interactive-session process, not the separate Windows service and user-session agent specified in the brief.

External pages and tool results are untrusted data. Workspace tools use path boundaries. Ask first requests consent for desktop actions; Auto desktop allows screen observation and desktop input without per-action prompts as requested. Saving screenshots, file deletion and applying verified changes still require fresh consent even in automatic mode. These controls are not an operating-system sandbox. Offline mode is not a firewall.

## Selected priorities

The user selected items 1–9 from the open-source comparison: Windows app control, current-browser integration, deeper research, voice activation, local speech output, saved routines, reminders, a memory dashboard, and durable task recovery. The later user decision supersedes wake-word activation: Jarvin should listen whenever the app runs, without a code word or hands-free switch. Phone control is deferred. Multi-source research, routines, reminders, the memory dashboard and task recovery have initial implementations; the selected capabilities remain incomplete. See [product status](PRODUCT-STATUS.md) for the current summary.

The current goal is reliable human-like desktop operation: seeing the visible desktop, selecting and switching windows, moving the pointer, clicking, typing, scrolling and managing windows. The agent has bounded scroll, foreground-checked pointer movement, move/minimize/maximize/restore, selected-display visual targeting, and one-step tab/window traversal with a fresh observation. The newest display and traversal paths passed compilation but have not been accepted through live tasks on the user's desktop. Scroll targets the center of the focused window, and drag-and-drop is not implemented. A sent input is not proof of the intended result. See [the full-product build order](FULL-PRODUCT-ROADMAP.md).

## Current acceptance ledger

| Brief area | Current state and evidence | Remaining acceptance work |
|---|---|---|
| Requirements and architecture | This tracker and source modules document the current path. | Complete per-requirement traceability, IPC contracts, lifecycle design, and threat model. |
| Windows service and session agent | Missing. | Implement secure per-user IPC, real SCM lifecycle, recovery, multi-session separation, and service tests. |
| Intent routing and agent loop | Chat tool loop, step limit, repeated-call guard and cancellation exist. | Separate deterministic fast commands; measure reliability with real workloads and implement persistent task state. |
| Ollama and hardware | Installed `qwen3.5:4b` supports tools and vision; verified RTX 5050 laptop GPU has 8,151 MiB VRAM. Tool-calling test and research run passed. | Hardware-aware routing, robust provider identity, resource contention, CPU fallback, and reproducible latency/VRAM benchmarks. |
| Internet research | Live Qwen runs searched, fetched Python documentation and returned links; a later run gathered three pages with `research_web`. Individual pages and results are bounded and failures are reported. | Exercise full desktop UI, query planning and follow-up searches, more websites, redirect and rate-limit behavior, long documents, and citation accuracy. One successful run is not evidence that all claims were correctly cited. |
| Website opening | Default-browser action and URL validation are implemented. A Chrome search tool can open a Google results page visibly; a local Qwen routing test used a simulated page to select Chrome search, focus and visual capture. A controlled Chrome test navigated to a local page with keyboard input, read its image, clicked a button, entered text and visually read the result. A separate live check opened Python's documentation in Chrome, visually clicked Tutorial and read the resulting page. | Verify live search results, diverse sites, network delays and redirects. These successful paths do not establish general browser reliability. |
| Current-browser integration | The included Chrome/Edge extension can explicitly share one active HTTP(S) tab for review and optional chat attachment using a short-lived local code. An isolated real Chrome test exercised the extension, and a separate isolated Electron test covered review and attachment with a simulated extension. | No persistent browser session, DOM actions, cross-tab control or full end-to-end test from the real extension through the app and model. Review on the target desktop, Edge compatibility, sensitive-page handling, and page scoping need further work. |
| Documents | Isolated Electron checks passed for DOCX, XLSX and PPTX creation, targeted edits and read-back, PDF output, and offline English OCR of an image and a rendered PDF page. | Check representative user files, rich layout fidelity and spoken document requests. |
| Screen vision | Selected-display and selected-window captures feed a local vision adapter. `visual_click` and `visual_type` locate a target, send real mouse/keyboard input, and examine a fresh image. One-step tab/window traversal sends a shortcut and observes the new screen. Earlier isolated Windows and controlled Chrome fixtures passed the prior visual path. Targets are bound to a pinned foreground window; clicks check the window and target region before input, and keyboard input checks focus. A failed observation after input reports that the input was already sent. | External websites and other applications, model accuracy over many layouts, repeated observation and recovery, mixed-DPI multi-display acceptance and continuous frame capture. Controlled fixtures do not establish general desktop reliability. |
| Window and app exclusions | Privacy settings store app process names and window-title phrases and can add entries from open windows. Built-in full-display capture stops when an excluded window is visible or the scan is uncertain; excluded window references are filtered, and the Windows input worker checks the current target before acting. | Live acceptance across browsers, document apps, changing titles, focus changes and multiple displays; external MCP/shell policy enforcement; independent security review. This is not an OS-level boundary. |
| Voice input/output | Jarvin listens automatically with voice enabled. AudioWorklet captures the mic. Qwen3-ASR 0.6B int8 is installed and selected for final English transcripts; Moonshine supplies fast interim text. A separate local process isolates Qwen's native ONNX runtime from Piper neural speech. Automatic Qwen requests now pass a bundled Silero VAD check after amplitude segmentation, with a fallback when the detector cannot load. Generated-speech floating-companion and packaged-app checks passed recognition, speech interruption, old-response cancellation and follow-up submission before this VAD change. In a 24-clip synthetic English corpus Qwen had 0/204 word errors and averaged 1.35 s decoding after segmentation before this change; end-silence detection adds about 650 ms. An unfinished typed draft stays intact. | The user's physical microphone, accent, room noise, loudspeaker echo and false-activation rate still need direct measurement. Silero's false-rejection rate and added latency are unmeasured. Final ASR is not streaming; synthetic checks do not establish natural real-time conversation. Ambient speech can become a request. |
| Windows control | Launch/input/screenshot tools and an initial Windows UI Automation adapter with temporary window/control references, selected-window inspection, text entry, mouse click and post-action inspection. A controlled WPF test found a window, entered text, clicked and verified the changed label. Installed Qwen also selected `visual_click` in a live Chrome documentation task and verified the resulting page. Foreground requests use a bounded retry and refuse input if Windows keeps another window active. Built-in app/window exclusions now gate capture and input. The adapter does not work with every app: the initial WinForms fixture exposed generic panes rather than usable controls. | Validate exclusions and reliable behavior across applications, broader model-driven acceptance tests, window lifecycle/arrangement, robust app discovery, multi-monitor DPI handling and broader end-to-end actions. |
| Coding agent | Workspace file, terminal, checkpoints, test and isolated-copy workflows exist. | Real repository acceptance scenarios, tighter command sandbox, VS Code companion and diagnostics integration. |
| Task state and recovery | Requests and tool activity are journaled locally before/during execution. On restart, unfinished records become interrupted; paused/interrupted requests can be reviewed as drafts and never restart automatically. An isolated Electron crash/restart test with a fake local model verified that review does not repeat a test action. | Full task plans, complete model/tool context and attachment restoration, background-job recovery, real-world crash scenarios, richer status and bounded retention. |
| Reminders | One-time reminders can be created and dismissed from Tasks, and the agent has a creation tool. Local records persist until removed; reminders overdue while Jarvin is closed are marked due at next launch. An isolated Electron test covers UI creation, restart and dismissal plus the agent tool with a fake model. A separate test had the installed `qwen3.5:4b` create a five-minute reminder in temporary storage. | Verify native Windows notifications and voice end-to-end; reminders require Jarvin to be running for delivery, are checked approximately every 30 seconds, and do not wake a sleeping PC. The Tasks panel recurrence, editing and snooze checks are recorded on the status board above. Native delivery confirmation is pending. |
| Saved routines | Locally stored named routines contain ordered natural-language instructions. Users can create, edit, delete, review or run them from Tasks; running uses the current folder, agent and approval settings. An isolated Electron test covers persistence and UI lifecycle, draft protection and denial of an agent action. Qwen successfully wrote and read a temporary file in one two-step routine test. | Steps are interpreted by the model, not a deterministic workflow engine; order and success are not guaranteed. No scheduling, parameters, per-step progress, voice selection, or verified resume. More real-world tests needed. |
| Memory | File-based memory and chat sessions; a dashboard lists, reads, edits and deletes individual saved memories. File operations have stale-revision tests, and an isolated Electron renderer test exercises the UI. | Real desktop end-to-end testing, scoped memory controls, retention, retrieval relevance, temporary mode and sensitive-data handling. |
| Stop and cancellation | Pending approvals and context summarization release on stop; document worker supports cancellation. Generated-microphone tests interrupted both local neural and Windows voice playback and cancelled the active model response before submitting a follow-up. A separate manual-microphone test stopped neural playback and cancelled the old streaming response. The floating pet's Stop reply action now signals both the main-process run and renderer audio, even after the model run has finished. | Physical microphone interruption, queued and background work, cancellation timing and unavoidable non-cooperative operations. |
| Privacy and policy | Auto desktop allows image-based screen observation and desktop control without per-action approval; Ask first can still request it. Saving screenshot files and deletion require fresh approval. Pause observation and initial built-in app/window exclusions are available. The vision adapter checks local host and disallows remote-host models/redirects, although its text result can be returned to the active chat model. | Exclusion enforcement for external MCP/shell paths, durable consent, offline network isolation and independent security review. |
| Overlay and tray | Assistant and coding views share the same chat. A movable animated robot floats by itself; dragging the character moves it, clicking opens Jarvin, and its right-click menu exposes microphone mute, code and stop actions. Live Windows interaction verified Float, drag and click-to-open. Isolated Electron tests exercise task and job status, approval and stop; generated speech was transcribed without a wake phrase through the companion. | Broader real desktop interaction, physical microphone and speaker validation, tray lifecycle, persistent background service, privacy mode and task status. Tasks do not continue after the app exits. |
| Proactive assistance | The current status board records spoken reminder playback and automated trigger checks. | Check hardware delivery for each opted-in trigger. |
| Audit and secrets | Audit and best-effort redaction before writing new audit and trace events exist. | Redaction is pattern-based and cannot guarantee removal of all sensitive data. Existing logs are not retroactively cleaned. Verify other storage paths, credential storage, retention controls, tamper resistance, permissions and secure updates. |
| Packaging | Source launcher and unpacked Windows app exist. An NSIS setup build completed earlier on 6 November 2026, but the rebuild after the microphone check failed twice with `spawn UNKNOWN` while generating the uninstaller. The portable rebuild was stopped after stalling. Older and incomplete release artifacts have non-release suffixes. | Run `npm run dist:safe` on the target PC (added 9 Nov 2026, untested there; `npm run dist:zip` is the fallback), then verify install/uninstall and upgrade on a clean profile, signing, real update feed, and model download. |
| Overall acceptance | Build/typecheck pass. Unit suite: 326 of 326 pass when run on Linux on 10 Nov 2026 (a stale negative-coordinate assertion was corrected); Windows-only paths still need a Windows run. CSPs no longer set `frame-ancestors` in a meta tag (it was ignored and logged an error on every start); CI now runs on Windows only. | Run every master-brief scenario A–J on the target machine; report measured p50/p95/p99 and failures. |

## Reproduce checks

Run `npm run typecheck`, `npm test`, and `npm run build`. The optional `npm run check:research`, `npm run check:research-multi`, `npm run check:vision`, `npm run check:reminder-live`, `npm run check:routine-live`, and `npm run check:documents` exercise the real local model, research tools, reminders, routines, and document workers. `npm run check:memory-ui` and `npm run check:recovery-ui` use hidden Electron windows and isolated in-memory stores. `npm run check:recovery-e2e` and `npm run check:assistant-ui` use isolated Electron processes and a fake model. `npm run check:browser-extension` and `npm run check:chrome-launch` use isolated headless Chrome profiles. `npm run check:chrome-visual` opens a fresh visible Chrome profile and operates a controlled local page with real mouse and keyboard input; add `-- --external-docs` for a scripted live Python documentation task or `-- --agent-docs` for a local-model agent choosing the visual click itself. `npm run check:handsfree-e2e` and `npm run check:companion-voice` copy the cached Whisper model into a temporary profile and feed generated speech to a fake microphone; they do not test the physical microphone. Run the build first for the document and Electron end-to-end checks. Live research makes web requests and live vision uses the repository's icon, not a screen capture. These tests do not imply the full desktop scenarios pass.

`npm run check:windows-uia` opens a temporary local WPF test window, moves the real mouse to its button, and checks the result. `npm run check:windows-uia-agent` asks the installed Qwen model to do that task through the agent loop. Run the build first and avoid using the mouse or keyboard while either test controls the fixture.

`npm run check:visual-desktop` opens an isolated full-screen fixture and uses the real mouse and keyboard, so do not use the computer until it completes. `npm run check:natural-voice` exercises the installed local voice worker; `npm run check:natural-voice-ui` copies that model to an isolated profile and tests muted playback in Electron. The local Joe voice is sourced from [Piper voices](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/joe/medium); model and bundled phonemizer licenses should be reviewed before redistribution.

The optional `qwen3-vl:4b-instruct` Ollama model was installed and located both buttons in the synthetic grounding check in 7.4 seconds including startup. Its real Windows fixture check stopped twice because Windows did not give the fixture foreground focus; no input was sent. It has not been selected as the default vision model without that end-to-end comparison.

`npm run check:voice-interruption` uses generated microphone audio, cached Whisper and Piper, a fake streaming chat model and muted output. `node scripts/handsfree-e2e.mjs --widget --interrupt --system` checks the Windows voice fallback. These verify software interruption, not physical echo cancellation. `node scripts/speech-accuracy-eval.mjs` compares recognition settings on generated quiet English commands; beam sizes 1 and 3 both produced zero word errors on these three samples, so the default decoder was retained.

`npm run check:qwen-voice` uses the installed Qwen3-ASR model with an isolated Electron profile and generated microphone audio. Add `--packaged` to `node scripts/handsfree-e2e.mjs --widget --interrupt --qwen` to check the unpacked Windows build. These checks were run before the user requested no further tests for the product-status update.

Voice settings now include an in-memory microphone check that reports the raw recognizer output, filtered/basic text, input level, threshold decision and decode time. It does not send a chat message or save the recording. The changed source compiled and bundled; its physical microphone behavior has not been checked yet.

## Live desktop findings, 9 November 2026

Run on the target Windows laptop with a real Jarvin window, `qwen3.5:4b`, Full auto, microphone listening.

| Finding | Status |
|---|---|
| Any loud sound cancelled a running task: speech onset called the reply interrupt before a transcript existed (two runs ended "Stopped." with no model output). | Fixed in `voiceui.ts`: onset only silences Jarvin's voice; a running task is cancelled only when a transcript arrives. Live run afterwards completed. |
| `launch_app` could not open Windows Settings, Control Panel or Store apps and the model retried the same call until the repeat guard stopped it. | Fixed in `launch.ts` (aliases, `ms-settings:` pages, Start-menu lookup, non-repeat error). Live: "Open the Windows Settings app" opened Settings in one call, about 5 s, confirmed with Settings closed first. |
| Chat model defaulted to `qwen3-vl:4b-instruct`, which answered that desktop control is unsupported instead of calling tools. | Fixed in `shared/models.ts` (vision models score lower, so a text model is the default) and `agent.ts` (note when the first reply says the model cannot act). Tested by unit tests only. |
| Main window and pet were not visible after first launch. | Cause: Windows refuses focus to a newly started app while another window is in front. Fixed with `raiseWindow` in `main.ts` (pins the window on top briefly). Verified live with Calculator in front. |
| `launch_app` reports "Started" without checking a window appeared; Jarvin then says it "should now be open". | Fixed: `launch_app` lists windows before and after, reports the new window, or brings an existing (even minimized) window forward (`window-check.ts`). Live: Calculator launch confirmed. |
| The 4B model often wrote "let me click…" and ended the turn with no tool call, so tasks stalled halfway. | Mitigated in `agent.ts`: up to two nudges per stall, reset after each tool call. A larger model is the real fix. |
| Calculator (Store app) listed twice and the wrong window was chosen; focus then failed with a "did not bring to foreground" error; hidden or minimized Store apps are not in the window list. | Fixed in `windows-uia.ts/.ps1` and `tools.ts` (inner window hidden from the list, same-title window in front counts as focused, `launch_app` re-finds and focuses a re-used window). Not yet re-tested live. |
| `visual_click` took about 10 s per click (two vision calls). | Added `observe=false` and a new `click_controls` tool (accessibility, no vision). Not yet timed live. |

### Live test checklist (everything below is built but not yet verified on the laptop)

1. Calculator: minimized Calculator is restored and `click_controls` presses 7 × 8 and reads 56 (no vision calls; target under 30 s).
2. Notepad: open, type text, `save_document` to a Desktop path, confirm the file exists; run "open Notepad" twice and confirm only one window.
3. Chrome: `chrome_search` then read results from the screen; a minimized Chrome is restored, not duplicated.
4. Window control: `window_manage` move, maximize, minimize, restore; `traverse_ui` between windows.
5. Multi-app: copy the Calculator result into Notepad.
6. Window raise: start Jarvin with another app in front; the Jarvin window must appear on top.
7. Voice: Jarvin speaking a reply must not cancel the next task (echo guard); a spoken "stop" still must.
8. Model stalls: the "promised an action" nudge fires and the task completes; a larger model gives fewer stalls.
9. New shortcuts (Ctrl+Shift+S, Ctrl+N, F5, Alt+Left, etc.) work, and Alt+F4 / Win-key combinations stay blocked.
10. Installer: `npm run dist:safe` on the laptop.

## Notes added after live testing (9 Nov)
- **Model stalls:** qwen3.5:4b often announces an action and stops. The agent nudges it twice. A 7–8B tool-calling model (for example qwen3:8b or qwen2.5:7b-instruct) stalls far less; pick one your GPU/RAM can hold with the chosen context size.
- **Voice:** the natural voice ("joe", Piper) only plays when `joe.onnx` and `joe.onnx.json` are in `%APPDATA%\jarvin\models\piper` (`node scripts/install-natural-voice.cjs` installs them from `scratchpad/kokoro-eval/piper`). The installer does not bundle them, so a fresh install uses the Windows fallback voice, now ranked by `src/shared/voicepick.ts` (Natural/Aria/Jenny/Guy before Zira/David).
- **Safety guard:** `src/main/selection-guard.ts` refuses Delete/Backspace/typing for two minutes after Ctrl+A. `launch_app` has `new_document` to open a blank document first.
- **Installer:** `npm run dist:safe` must be run on Windows (PowerShell). Not run yet.
- **Split:** the codebase/semantic index code now lives in `src/main/codebase-index.ts` (tools.ts 1783 lines).

## Live results (9 Nov, qwen3.5:4b)
| Test | Result |
|---|---|
| Calculator 7×8 via click_controls | Pass |
| Notepad type + save (new_document, verified save) | Pass, 22 s, 3 tool calls (was 128 s, wrong window) |
| Chrome search "today's weather" | Pass, 29 s |
| Minimize Calculator, then reopen | Pass, 12 s |
| Typing dropped letters ("Hello rom", "NAAZ") | Fixed by sending text 3 characters at a time; retest the long-text case |
| save_document claimed success on "Path does not exist" | Fixed: now checks for a leftover dialog and the window title |
Not yet tested live: voice echo guard, multi-app task, keyboard shortcuts, installer.
- **Typing (9 Nov, later):** sending text 3 characters at a time still dropped a letter ("The uick brown"). `keyboard_type` and the `save_document` path now paste via the clipboard (`src/main/type-text.ts`, clipboard restored afterwards, falls back to key-by-key). Live retest: all 105 characters exact.
- **Open issue:** with the mic on, background audio (music) was transcribed and sent as a task ("It's my crystal high above."). Consider requiring the wake word or confirmation for voice-triggered tasks.
