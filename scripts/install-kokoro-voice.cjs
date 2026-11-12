// Copies the downloaded Kokoro voice pack into %APPDATA%\jarvin\models\kokoro (never overwrites a different file).
const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve('scratchpad/kokoro');
const target = path.join(process.env.APPDATA, 'jarvin', 'models', 'kokoro');
const need = ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt'];
for (const f of need) if (!fs.existsSync(path.join(source, f))) throw new Error(`Missing ${f} in ${source}`);
fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
for (const f of need) if (fs.statSync(path.join(source, f)).size !== fs.statSync(path.join(target, f)).size) throw new Error(`${f} did not copy correctly.`);
console.log(`Kokoro voice installed at ${target}`);
