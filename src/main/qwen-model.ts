import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { QWEN_ASR_DIR, type VoiceProgress } from '../shared/voice';

// Pin the release archive so the native recognizer never opens unverified weights.
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${QWEN_ASR_DIR}.tar.bz2`;
const SHA256 = '393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96';
const SIZE = 878_702_423;
const MAX_BYTES = 1_100_000_000;
const REQUIRED = ['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx', 'tokenizer/vocab.json'];

export async function downloadQwenAsr(cacheDir: string, progress: (p: VoiceProgress) => void): Promise<void> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const destination = path.join(cacheDir, QWEN_ASR_DIR);
  if (REQUIRED.every((file) => fs.existsSync(path.join(destination, file)))) return;
  const staging = fs.mkdtempSync(path.join(cacheDir, '.qwen-asr-'));
  const archive = path.join(staging, 'model.tar.bz2');
  const withinCache = (candidate: string) => {
    const root = path.resolve(cacheDir);
    const target = path.resolve(candidate);
    if (!target.startsWith(root + path.sep)) throw new Error('Invalid speech model cache path.');
    return target;
  };
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(20 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Speech model download failed (HTTP ${response.status}).`);
    const statedSize = Number(response.headers.get('content-length') || 0);
    if (statedSize > MAX_BYTES) throw new Error('Speech model download is larger than expected.');
    const hash = createHash('sha256');
    let bytes = 0;
    let lastPct = -1;
    await pipeline(
      Readable.fromWeb(response.body as any),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) return callback(new Error('Speech model download is larger than expected.'));
          hash.update(chunk);
          const pct = Math.min(99, Math.round(bytes / (statedSize || SIZE) * 100));
          if (pct !== lastPct) { lastPct = pct; progress({ state: 'downloading', pct, file: QWEN_ASR_DIR }); }
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(archive),
    );
    if (hash.digest('hex') !== SHA256) throw new Error('Speech model download failed its integrity check.');
    progress({ state: 'loading' });
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-xjf', archive, '-C', staging], { windowsHide: true });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Could not unpack the speech model (tar exit ${code}).`)));
    });
    const extracted = path.join(staging, QWEN_ASR_DIR);
    if (!REQUIRED.every((file) => fs.existsSync(path.join(extracted, file)))) throw new Error('The downloaded speech model is incomplete.');
    if (fs.existsSync(destination)) fs.rmSync(withinCache(destination), { recursive: true, force: true });
    fs.renameSync(extracted, destination);
  } finally {
    // staging is created directly under cacheDir and contains only this download.
    fs.rmSync(withinCache(staging), { recursive: true, force: true });
  }
}
