// Speech detector process. Runs the Silero voice-activity model on onnxruntime (a signed module, unlike sherpa-onnx)
// and answers "how likely is it that this audio is someone speaking?". It keeps no audio.
import * as ort from 'onnxruntime-node';
import { VadStream, type VadModel } from '../shared/vad';

const modelFile = process.argv[2];
let stream: VadStream | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<VadStream> {
  if (stream) return stream;
  const session = await ort.InferenceSession.create(modelFile, { intraOpNumThreads: 1, interOpNumThreads: 1 });
  const rate = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
  const model: VadModel = async (input, state) => {
    const out = await session.run({ input: new ort.Tensor('float32', input, [1, input.length]), state: new ort.Tensor('float32', state, [2, 1, 128]), sr: rate });
    return { probability: Number((out.output.data as Float32Array)[0]), state: out.stateN.data as Float32Array };
  };
  return (stream = new VadStream(model));
}

process.on('message', (message: { id: number; audio?: Float32Array; reset?: boolean }) => {
  queue = queue.then(async () => {
    try {
      const vad = await load();
      if (message.reset) vad.reset();
      const audio = message.audio instanceof Float32Array ? message.audio : new Float32Array(message.audio ?? []);
      process.send?.({ id: message.id, probability: audio.length ? await vad.score(audio) : 0 });
    } catch (e: any) {
      process.send?.({ id: message.id, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) });
    }
  });
});
process.on('disconnect', () => process.exit(0));
