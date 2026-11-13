# Jarvin capabilities

Snapshot: 9 November 2026 for sections 2 to 7; sections 1, 8 and 9 were brought up to date on 13 November 2026. "Live-tested" means it passed on the real Windows PC. "Built" means the code and automated tests pass, but it has not been run live yet. "Checked with recordings" means the real app was given saved recordings of the user's voice as its microphone; nobody spoke into it live. The day-by-day record is the [implementation tracker](JARVIS-IMPLEMENTATION.md).

## 1. Talking to Jarvin
| Capability | Status |
|---|---|
| Chat in the Assistant view and the Code view | Live-tested |
| Floating pet: draggable, click to open, right-click menu (Open, Mute microphone, Pause screen observation, Open code, Review paused tasks, Pause task, Stop reply, Quit) | Live-tested |
| Microphone switch: off at start; switched on from the chat box or the pet. Nothing is recorded while it is off | Live-tested (the switch); listening itself checked with recordings |
| Local speech recognition with Qwen3-ASR and a name hint; fallback recognizers if Windows blocks it, with a retry and an on-screen "(weaker)" label | Measured on the user's 20 recordings: 1 wrong word in 160 |
| Trained speech detector (Silero): fans, typing and music are not treated as speech | Checked with recordings and generated noise; not in a real noisy room |
| Wake phrase required: only speech that starts with "Hey Jarvin" (or "Jarvin" / "Hey Jarvis") runs. Saying only the name opens a 10-second window for the request | Checked with recordings (name heard 10 of 10) |
| "Stop" without the name, at any time; while a task runs only a stop word interrupts it; an early check acts on "stop" before the sentence ends | Stop rule checked in the real app with generated speech; the early check is built but not seen firing in a real task |
| Junk filter: made-up hearings ("thank you", impossible speech rates, repeated phrases) are dropped | Built |
| Push-to-talk: hold the mic button, Ctrl+Shift+M or the pet's mic button; no name needed | Built |
| Ignores its own voice picked up by the microphone | Built |
| Spoken replies: natural local voice (Kokoro if installed, else the bundled Piper "joe"), otherwise a Windows voice | Built; audio starts in the real app; not judged by ear |
| Voice commands (stop, send, new chat) and approving or denying by voice | Built |
| Interrupts its own speech or a running reply when you speak | Built |
| Dictate into any app (voice paste) | Built |

## 2. Controlling apps and windows
| Capability | Tool | Status |
|---|---|---|
| Open an app, or bring back an already-open or minimized one | `launch_app` | Live-tested |
| Open a new blank document in an editor (Ctrl+N, confirmed by the window title) | `launch_app` with `new_document` | Live-tested |
| List open windows, focus one, minimize, maximize, restore | `desktop_list_windows`, `focus_window`, `window_manage` | Live-tested |
| Bring another app's window to the front even when Windows blocks it | focus workaround (Alt tap + input attach) | Live-tested |
| Press named buttons in an app (for example Calculator 7 × 8) | `click_controls` | Live-tested |
| Click or type by describing what is on screen | `visual_click`, `visual_type`, `locate_screen_target`, `click_visual_target` | Built, earlier runs passed |
| Read the UI controls of a window | `traverse_ui`, `desktop_inspect_window` | Built |
| Type text exactly (pasted through the clipboard, clipboard restored) | `keyboard_type` | Live-tested |
| Press keys and shortcuts (Enter, Tab, Ctrl+A/C/V/Z/S/N/O/W/L/T/F, Ctrl+Shift+S, F2, F5, Alt+Left/Right and others) | `keyboard_press` | Built |
| Save the open document under a full path, and check that it saved | `save_document` | Live-tested |
| Snap windows to the left, right, top or bottom half of the screen; put two apps side by side | `window_manage` snap_left/right/top/bottom | Live-tested |
| Change volume, mute, brightness (laptop screens), dark or light mode, lock the screen | `system_control` | Volume live-tested (result reported; not heard); the rest built |
| Read the text you have selected in an app, then summarize, translate or replace it | `get_selected_text`, `keyboard_type` | Built |
| Scroll, move the mouse, click | `desktop_scroll`, `mouse_move`, `mouse_click` | Built |
| Read and write the clipboard | `clipboard_read`, `clipboard_write` | Built |

Safety guards: Jarvin cannot press Delete or Backspace or type for two minutes after Select All; it cannot send Alt+F4 or Windows-key combinations; it opens new documents instead of reusing yours.

## 3. Seeing the screen
| Capability | Tool | Status |
|---|---|---|
| Describe a window using the local vision model (qwen3-vl) | `see_window` | Live-tested |
| Describe the whole screen or one monitor | `inspect_screen`, `list_displays`, `screen_capture`, `screenshot` | Live-tested |
| Pause or resume screen observation from the pet menu; excluded apps and windows | settings | Built |

## 4. Web and browser
| Capability | Tool | Status |
|---|---|---|
| Open Chrome and search visibly, then read the results | `chrome_search`, `open_website` | Live-tested |
| Web search, fetch a page, multi-source research | `web_search`, `web_fetch`, `research_web` | Built |
| Hidden browser: open, read, click, type, close | `browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_close` | Built |

## 5. Your files
| Capability | Tool | Status |
|---|---|---|
| Find your files by name in Desktop, Documents and Downloads (including OneDrive copies) | `find_user_file` | Live-tested |
| Open one in its default app (programs and scripts are refused) | `open_user_file` | Live-tested |
| Read PDF, Word, CSV, Excel and PowerPoint files | `read_pdf`, `read_docx`, `read_csv`, `read_xlsx`, `read_pptx` | Built |
| Read, write, edit, copy, move, delete and search files in the project folder | `read_file`, `write_file`, `edit_file`, `copy_file`, `move_file`, `delete_file`, `find_files`, `search_files`, `list_dir` | Built |
| Open a project file or reveal it in Explorer | `open_path`, `reveal_in_explorer` | Built |

## 6. Reminders, tasks and memory
| Capability | Tool | Status |
|---|---|---|
| One-time reminders and notifications; a Windows scheduled task shows a pop-up about 90 s after the due time if Jarvin has been closed | `create_reminder`, `notify` | Built |
| Task list, background commands | `task_list`, `background_start/output/list/stop` | Built |
| Save, list, read and delete memories | `memory_save`, `memory_list`, `memory_read`, `memory_delete` | Built |
| Search past chats | `list_chat_sessions`, `read_chat_session`, `search_chat_history` | Built |
| Skills and file converters | `list_skills`, `read_skill`, `list_converters` | Built |

## 7. Coding (Code view)
Run commands and tests, apply patches, search and map a codebase (including semantic search), view problems, use Git (status, diff, log, branch, commit, checkout, stash), run sub-agents and verified changes in separate work trees. Status: built.

## 8. How it runs
- Local-first: Ollama runs the chat model (`qwen3:8b`, the user's choice since 12 November; `qwen3.5:4b` is the alternative) and the vision model (`qwen3-vl:4b-instruct`). Jarvin starts Ollama if it is not running, and keeps your saved model when Ollama is down. Cloud models through an OpenAI-compatible service are optional.
- Tool list is trimmed per request: a plain desktop task now sends the model 28 tools (12.4k characters) instead of 48 (17.5k).
- Permission modes (for example Full auto); destructive actions keep a fresh-consent rule; tools that run commands or MCP tools ask first.
- Task traces are saved so a run can be reviewed.

## 9. Known limits
- A small local chat model sometimes announces an action and stops, or reports the result it expected. Jarvin nudges it twice and tools report what they really observed.
- Screen tasks are slow with `qwen3:8b`: 15 to 18 seconds per look on 8 GB of graphics memory, because the chat and vision models swap.
- Voice has been measured on saved recordings and generated noise, not with a person speaking live in a real room.
- If Jarvin is closed, a reminder pop-up comes from a Windows scheduled task about 90 seconds late (not tested live).
- Wi-Fi, Bluetooth and Do Not Disturb switches are not built (dropped by the user).
- The Piper "joe" voice is bundled. The smoother Kokoro voice is optional: run `node scripts/install-kokoro-voice.cjs`.
- On the development PC, Smart App Control blocks the unsigned installer, so `npm run dist:safe` builds a zip, which is rebuilt and started after each batch of changes. GitHub Actions builds an unsigned Setup .exe on request; it has not been installed on a clean PC.
- Not yet tested live: most keyboard shortcuts beyond Ctrl+N/S, brightness, dark mode, lock screen.
- Automatic resume after a crash or restart is built and was confirmed live on 11 November: the newest interrupted task is offered again once. Phone control is out of scope.

## Routines (built, not live-tested)
- `routine` tool: list / save / run named multi-step routines (e.g. "work setup"); run returns the steps for Jarvin to carry out with its other tools. Stored in the existing routine store.
