"""Compare a local CPU recognizer on one generated English voice clip, not live microphone audio."""
import os
import time
from faster_whisper import WhisperModel

start = time.perf_counter()
model = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=4,
                     download_root=os.path.abspath("scratchpad/faster-whisper-eval/models"))
print(f"Model load: {time.perf_counter() - start:.2f}s", flush=True)
for i in range(2):
    start = time.perf_counter()
    segments, _ = model.transcribe("scratchpad/faster-whisper-eval/speech.wav", beam_size=1, language="en", condition_on_previous_text=False)
    text = " ".join(segment.text.strip() for segment in segments)
    print(f"Pass {i+1}: {time.perf_counter() - start:.2f}s: {text}", flush=True)
