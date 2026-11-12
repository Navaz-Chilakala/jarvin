# Running Jarvin in the background: design note

10 November 2026. Covers tracker item "Windows service and session agent". Nothing here is built yet.

## Recommendation

Do not build a Windows service now. Build a **per-user background mode** instead: Jarvin starts at sign-in, hidden, and stays running when the window is closed. It delivers everything the service was wanted for on a single-user laptop, needs no administrator rights, and adds no new executable for Smart App Control to block.

Revisit a real service only if one of these becomes a requirement: work while no user is signed in, more than one Windows user on the same PC, or a remote (phone) controller.

## What the service was meant to solve

| Need | Today | Gap |
|---|---|---|
| Reminders fire when the window is closed | Closing the window hides Jarvin behind the pet, so they fire. If Jarvin has quit, a Windows scheduled task shows a pop-up 90 s after the due time. | None while signed in. |
| Scheduled routines run | Only while Jarvin is running (checked every 30 s). | Jarvin is not started at sign-in, so a routine is missed after a reboot until the user opens Jarvin. |
| Long tasks survive closing the window | Yes: the window hides and the run continues. | They do not survive Quit, a crash, sleep or sign-out. Auto-resume covers a crash once. |
| Jarvin is there after a reboot | No. The user starts it. | This is the main gap. |
| Recovery if Jarvin crashes | The next manual start marks the task interrupted and continues it once. | Nothing restarts Jarvin. |

## Why a real service is a poor fit here

1. **A service cannot see or touch the desktop.** Windows services run in session 0, apart from the user's screen, mouse, keyboard and microphone. Everything Jarvin does (clicks, typing, screenshots, listening, speaking) would still have to run in a second process inside the user's session. The service would only schedule and supervise.
2. **Administrator rights.** Installing, updating and removing a service all need elevation. Jarvin installs per user today with no prompt.
3. **Smart App Control.** On this PC it blocks unsigned executables that have no reputation: it already blocked the installer and the speech module. A new unsigned service host would very likely be blocked too. This needs code signing first.
4. **Security surface.** A service that accepts commands from a user process needs an authenticated channel (a named pipe restricted to the user's SID, with the service checking the caller). Done wrong, it is a way for any local program to drive the desktop agent.
5. **Ollama and the models are per user.** The model server, model files and Jarvin's data all live in the user profile. A service running as LocalSystem would not see them without extra work.

## Option A: per-user background mode (recommended)

One process, as today. Four additions:

1. **Start at sign-in, hidden.** Electron's `app.setLoginItemSettings({ openAtLogin: true, args: ['--background'] })` writes the per-user Run key. With `--background`, Jarvin starts without showing the window (pet only, or nothing, per setting). A setting turns it on; it is off by default.
2. **Tray icon.** Open, Mute microphone, Pause observation, Quit. Today the pet is the only handle once the window is hidden.
3. **Restart after a crash.** A small watchdog: on `render-process-gone` and `child-process-gone`, reload or relaunch (`app.relaunch()`), at most 3 times in 10 minutes, then stop and say so. Auto-resume already limits a crashing task to one retry.
4. **Catch up after sleep.** On `powerMonitor` `resume` and `unlock-screen`, run the reminder and routine checks at once. A routine missed by more than its 15-minute grace period stays skipped; reminders are never skipped.

Not included: running while signed out, running for other Windows users, running during sleep.

Effort: about a day. No new process, no elevation, no IPC protocol. Testable with the existing isolated Electron checks plus one new start-hidden check.

Risks:
- An always-running Jarvin holds the microphone and, when a model is warm, GPU memory. Background start should not warm models or open the microphone until first use, or until the user's setting says to.
- A second copy started by hand must hand over to the running one. The single-instance lock already does this.

## Option B: Windows service plus session agent

Two processes:

- **Service** (`JarvinService`, LocalService account): owns the schedule (reminders, routines), the durable task queue and its journal, and starts or restarts the agent. No screen, no microphone, no model calls.
- **Session agent** (today's app): everything interactive. Connects to the service over a named pipe `\\.\pipe\jarvin-<user SID>`, ACL'd to that user; the service verifies the client's SID and executable path before accepting commands.

Lifecycle: installed and removed by the installer (elevated); start type Automatic (Delayed); recovery actions restart on failure. On session logon the service launches the agent in that session (`WTSQueryUserToken` + `CreateProcessAsUser`), which needs LocalSystem rather than LocalService. That is the largest privilege in the design.

Needs first: code signing, a working installer, a decision on the service host (Node has no first-class service support; realistic choices are a small native or .NET host, or a third-party wrapper, each another binary to sign).

Effort: one to two weeks including installer work and tests, and it cannot be tried on this PC until signing is sorted.

## Option C: scheduled tasks only

Use Task Scheduler for start-at-logon and for each routine, the way reminders already have a backup task. No admin rights. But routine tasks would have to launch Jarvin with a "run routine X" argument, which duplicates what Option A gets from simply being running, and every schedule change means rewriting tasks. Option A with the Run key is simpler.

## Decisions needed

1. Go with Option A?
2. In background mode after sign-in: pet visible or fully hidden (tray only)?
3. Should the microphone listen from sign-in, or only after the window is first opened?
