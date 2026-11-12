// Removes the plain studio background from the pet render and writes src/renderer/pet.png with a transparent background.
// Run: node_modules\electron\dist\electron.exe scripts\cutout-pet.cjs <render image> [output name, default pet.png]
// The background is grown inward from the image border across pixels that change smoothly (a studio backdrop and its soft
// shadow); the plush edge is a sharp jump in colour, so growth stops there.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(() => {
  const src = nativeImage.createFromPath(process.argv[2]);
  const { width: w, height: h } = src.getSize();
  const px = Buffer.from(src.toBitmap()); // BGRA
  const step = 7;
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => { if (!bg[i]) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  const near = (a, b) => Math.abs(px[a * 4] - px[b * 4]) <= step && Math.abs(px[a * 4 + 1] - px[b * 4 + 1]) <= step && Math.abs(px[a * 4 + 2] - px[b * 4 + 2]) <= step;
  // The backdrop is neutral grey; plush fur is brighter and warmer. This keeps growth from leaking into soft fur shading.
  const backdrop = (i) => { const b = px[i * 4], g = px[i * 4 + 1], r = px[i * 4 + 2]; return Math.max(r, g, b) < 222 && r - b < 14; };
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!bg[j] && near(i, j) && backdrop(j)) push(j);
    }
  }
  // Pockets of backdrop the border cannot reach (between the legs, under the headphone band): patches that match the
  // backdrop's average colour and are big enough not to be a stray fur shadow.
  let sb = 0, sg = 0, sr = 0, n0 = 0;
  for (let i = 0; i < w * h; i++) if (bg[i]) { sb += px[i * 4]; sg += px[i * 4 + 1]; sr += px[i * 4 + 2]; n0++; }
  const mb = sb / n0, mg = sg / n0, mr = sr / n0, tol = 26;
  const like = (i) => !bg[i] && backdrop(i) && Math.abs(px[i * 4] - mb) < tol && Math.abs(px[i * 4 + 1] - mg) < tol && Math.abs(px[i * 4 + 2] - mr) < tol;
  const seen = new Uint8Array(w * h), minPatch = Math.round(w * h * 0.0004);
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !like(s)) continue;
    const patch = [s]; seen[s] = 1;
    for (let k = 0; k < patch.length; k++) {
      const i = patch[k], x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && like(j)) { seen[j] = 1; patch.push(j); }
      }
    }
    if (patch.length >= minPatch) for (const i of patch) bg[i] = 1;
  }
  // Soften the edge: each pixel's opacity is the share of non-background pixels around it.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let keep = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      n++; if (!bg[ny * w + nx]) keep++;
    }
    const i = y * w + x, a = bg[i] ? 0 : Math.round(255 * Math.min(1, keep / n * 1.25));
    px[i * 4 + 3] = a;
    if (a < 255) { px[i * 4] = Math.round(px[i * 4] * a / 255); px[i * 4 + 1] = Math.round(px[i * 4 + 1] * a / 255); px[i * 4 + 2] = Math.round(px[i * 4 + 2] * a / 255); } // premultiplied, as Electron expects
  }
  // Crop to the figure with a small margin.
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const m = 2; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  let out = nativeImage.createFromBitmap(px, { width: w, height: h }).crop({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
  // 560 px tall is four times the pet's on-screen size: sharp on high-DPI displays without a multi-megabyte file.
  if (out.getSize().height > 560) out = out.resize({ height: 560, quality: 'best' });
  const dest = path.resolve(__dirname, '..', 'src', 'renderer', path.basename(process.argv[3] || 'pet.png'));
  fs.writeFileSync(dest, out.toPNG());
  const s = out.getSize();
  console.log(`wrote ${dest} ${s.width}x${s.height}; background share ${(100 * bg.reduce((a, b) => a + b, 0) / (w * h)).toFixed(0)}%`);
  app.quit();
});
