// Draws assets/icon.png and assets/icon.ico from the floating pet's picture (src/renderer/pet.png), so the icon and the pet match.
// Run: node_modules\electron\dist\electron.exe scripts\make-icon.cjs [--preview <folder>]
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pet = `data:image/png;base64,${fs.readFileSync(path.join(root, 'src', 'renderer', 'pet.png')).toString('base64')}`;
const previewDir = process.argv.includes('--preview') ? process.argv[process.argv.indexOf('--preview') + 1] : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-icon-'));

// The icon: the pet's head and shoulders rising from the bottom of a rounded night-sky tile.
function iconPage(size) {
  const file = path.join(tmp, `icon${size}.html`);
  fs.writeFileSync(file, `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden;width:${size}px;height:${size}px"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3f47a0"/><stop offset="1" stop-color="#191c44"/></linearGradient><clipPath id="round"><rect width="512" height="512" rx="112"/></clipPath></defs>
  <g clip-path="url(#round)"><rect width="512" height="512" fill="url(#tile)"/><circle cx="84" cy="88" r="7" fill="#fff" opacity=".55"/><circle cx="436" cy="112" r="5" fill="#fff" opacity=".45"/><circle cx="404" cy="58" r="3.5" fill="#fff" opacity=".4"/>
  <image href="${pet}" x="26" y="52" width="460" height="647" preserveAspectRatio="xMidYMin meet"/></g></svg></body></html>`);
  return file;
}

async function shot(file, size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage();
  win.destroy();
  return image.resize({ width: size, height: size, quality: 'best' });
}

/** An .ico holding PNG-compressed images, which Windows Vista and later read at every size. */
function ico(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* stay alive between shots; the script quits when done */ });
app.whenReady().then(async () => {
  const big = await shot(iconPage(512), 512);
  if (previewDir) {
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'icon-256.png'), big.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
    fs.writeFileSync(path.join(previewDir, 'icon-32.png'), big.resize({ width: 32, height: 32, quality: 'best' }).toPNG());
    console.log('preview written to', previewDir);
  } else {
    fs.writeFileSync(path.join(root, 'assets', 'icon.png'), big.toPNG());
    fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), ico([256, 128, 64, 48, 32, 24, 16].map((size) => ({ size, png: big.resize({ width: size, height: size, quality: 'best' }).toPNG() }))));
    console.log('wrote assets/icon.png and assets/icon.ico');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
