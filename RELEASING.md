# Building and updating Jarvin

Current local build note (10 November 2026): `release\Jarvin-0.1.0-win.zip` and `release\win-unpacked` are current. There is no Setup .exe: this PC cannot build one (see below). The zip was unzipped to a temp folder and started hidden with a separate profile and safe mode: the window loaded and the UI rendered (10 Nov). Voice, Ollama and a real task were not exercised from the zip.

## If the installer build fails with `spawn UNKNOWN`

Cause, confirmed on the target PC on 10 November 2026: Smart App Control is on. To create the uninstaller, electron-builder runs the freshly built, unsigned setup stub, and Smart App Control blocks it (Code Integrity event 3077 names `release\Jarvin-Setup-0.1.0.exe`). Defender exclusions do not help, and the finished unsigned installer could not be run on that PC either. Smart App Control cannot be turned back on once it is off, so leave it alone.

- On a PC with Smart App Control on, `npm run dist:safe` now builds `release\Jarvin-<version>-win.zip` instead (confirmed). Unzip it anywhere and run `Jarvin.exe`. A zip install cannot update itself.
- For a real Setup .exe, run the `installer` job of the CI workflow from the GitHub Actions tab (not yet run; the project is not on GitHub yet), or build on a PC without Smart App Control. A PC with Smart App Control will only run the installer once it is code-signed.
- `npm run dist:clean` removes `.old`, `.stale` and `.failed` leftovers and any blocked setup stub.

## Build the installer (on Windows)

1. `npm install` (once, and again after pulling new code: it adds the update library).
2. `npm run dist`
3. Find `release\Jarvin-Setup-<version>.exe` and `release\latest.yml`.

Run the .exe to install. It installs for your user only (no admin prompt), makes Desktop and Start Menu shortcuts, and keeps your settings, chats and models (they live in `%APPDATA%\jarvin`, the same place as when you run from source).

The installer is not code-signed, so Windows SmartScreen may say "unknown publisher" the first time: choose More info, then Run anyway.

`npm run dist:portable` builds a single .exe that needs no install. A portable build cannot update itself.

## Ship an update

1. Raise `"version"` in `package.json` (for example 0.1.0 to 0.2.0).
2. `npm run dist`.
3. Upload these files from `release\` to one folder on a web server that uses https (GitHub Pages, Netlify, Cloudflare Pages, S3, your own server):
   - `latest.yml`
   - `Jarvin-Setup-<version>.exe`
   - `Jarvin-Setup-<version>.exe.blockmap`
4. In the installed Jarvin: Settings, Updates, paste the folder's address (for example `https://example.com/jarvin`), press Check now. Jarvin shows the new version, you press Download, then Restart and install.

Jarvin never downloads or installs anything by itself. Quiet checking at start-up only looks for a new version number and tells you.

## Notes

- The address must start with `https://` (plain http is accepted only for this PC, for testing).
- Updates only work in the installed app. Running from source (`launch.vbs`) never checks.
- Nothing here is verified against a real server yet. Test once with a version bump before relying on it.
