import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import type { WakeModels } from '../shared/wake';

export const WAKE_FILES = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'];

/** Loads openWakeWord's three models from a folder, or returns null when they are not installed. They are optional. */
export async function loadWakeModels(dir: string): Promise<WakeModels | null> {
  if (!WAKE_FILES.every((f) => fs.existsSync(path.join(dir, f)))) return null;
  const open = (f: string) => ort.InferenceSession.create(path.join(dir, f), { intraOpNumThreads: 1, interOpNumThreads: 1 });
  const [mel, embed, wake] = await Promise.all(WAKE_FILES.map(open));
  const run = async (session: ort.InferenceSession, data: Float32Array, dims: number[]) => {
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, dims) });
    return out[session.outputNames[0]].data as Float32Array;
  };
  return {
    mel: (samples) => run(mel, samples, [1, samples.length]),
    embed: (window) => run(embed, window, [1, 76, 32, 1]),
    score: async (features) => Number((await run(wake, features, [1, 16, 96]))[0]),
  };
}
