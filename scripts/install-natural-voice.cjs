// Installs the bundled, checksum-verified natural voice (assets/voice/piper) without overwriting existing files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = path.resolve(__dirname, '..', 'assets', 'voice', 'piper');
const target = path.join(process.env.APPDATA, 'jarvin', 'models', 'piper');
const hashes = {
  'joe.onnx': '58afce0321b8d9c46d7cdf9c16500cc55a793b4220212dba6b70fb788b3baf06',
  'joe.onnx.json': '3d6d5410b3795cb1950595247ef8f06190719e6fdbfa3a2356d8ec368e1aad33',
};
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(target, { recursive: true });
for (const [name, expected] of Object.entries(hashes)) {
  const from = path.join(source, name), to = path.join(target, name);
  if (hash(from) !== expected) throw new Error(`Downloaded ${name} did not match its expected checksum.`);
  if (fs.existsSync(to) && hash(to) !== expected) throw new Error(`A different ${name} already exists; it was not overwritten.`);
}
for (const [name, expected] of Object.entries(hashes)) {
  const from = path.join(source, name), to = path.join(target, name);
  if (!fs.existsSync(to)) { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); if (hash(to) !== expected) throw new Error(`Installed ${name} failed verification.`); }
}
console.log(`Verified local neural voice installed at ${target}`);
