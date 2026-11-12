# Local companion validation — 6 November 2026

Test machine: RTX 5050 Laptop GPU (8 GB), 24 GB RAM, Windows.

## Model selection

- Qwen 3.5 4B: tool use and conversation, 16K context, thinking disabled for quicker replies.
- Qwen3-VL 4B Instruct: screenshot understanding, 4K context.
- Moonshine base q8: fast English speech recognition and interim text, about 64 MB.
- Qwen3-ASR 0.6B int8: higher-accuracy final English transcripts on a separate local CPU process, about 1 GB installed. The model archive is SHA-256 verified before use.
- Distil Whisper small.en q8: optional accuracy setting, about 172 MB, already downloaded.
- Piper Joe: installed local neural speech. Audio is generated sentence by sentence.

Speech runs on the CPU; Ollama uses the GPU. Both Qwen models were simultaneously resident at 100% GPU, using about 7,711 MiB total GPU memory including other processes. This leaves little headroom for games or other GPU-heavy applications. Startup preloads installed local models, without prompts/images, and requests retain them for 15 minutes.

## Measurements

Synthetic speech corpus: four desktop commands, three installed English voices (Ravi, Heera, Zira), two volume levels; 24 clips / 204 reference words. These are generated voices, not recordings of the user's accent or room.

| Recognizer | Mean transcription time | Word errors |
|---|---:|---:|
| Whisper base.en | 1.23 s | 6 / 204 |
| Distil small.en | 2.55 s | 0 / 204 |
| Moonshine base | 0.26 s | 4 / 204 |
| Qwen3-ASR 0.6B int8 | 1.35 s | 0 / 204 |

Moonshine misrecognized one Ravi clip containing “Visual Studio Code”. The fast option is not universally more accurate; Distil remains selectable for difficult speech. No benchmark-specific dictionary corrections were applied.

Qwen3-ASR was added as a selectable recognizer and installed for this machine. It had no word errors in the same generated 24-clip corpus. The app keeps Moonshine for optional interim text and runs Qwen in a separate process so its native ONNX library does not interfere with the Piper speaking voice. In the isolated floating-companion test, Qwen recognized a spoken request, interrupted active Piper speech, cancelled the old response, and submitted the new request. Qwen decoding took 1.25 s in that run; end-silence detection added about 650 ms. These generated-voice tests do not establish accuracy for the user's microphone, accent, background noise, or speaker echo. A real microphone trial is still needed for that.

An isolated Electron test with the real Moonshine worker and Piper playback passed automatic listening, floating-window operation, cancellation during speech, subsequent voice submission, draft preservation, and pet mute/resume. Speech processing took 684 ms in that run. The fake microphone and muted speaker do not validate physical acoustic echo cancellation. End-of-speech detection adds approximately 650 ms plus audio frame granularity.

The microphone recorder now uses AudioWorklet in Electron and falls back to ScriptProcessor only if the worklet cannot start. The isolated fake-microphone interruption check confirmed the worklet path without the deprecated ScriptProcessor warning; local Moonshine processing took 272 ms in that run. This measures recognition after an utterance is segmented, not the full delay to a spoken answer.

Voice settings now include **Check microphone accuracy**. It pauses automatic listening, captures a phrase for at most ten seconds in memory, and displays the raw recognizer output, artifact filtering, basic cleanup, microphone RMS/peak, speech-threshold time and decode time. It sends no chat request and saves neither audio nor diagnostic text. This UI has been compiled but has not been exercised with the user's physical microphone.

Continuous pet screen capture initially delayed the segment-close-to-transcript path: one synthetic floating run took 891 ms despite 278 ms of Moonshine work, versus 228 ms in the main window. Background screen sampling now pauses while speech is being heard or transcribed; visual tools can still request a fresh image. The same floating test then took 239 ms from segment closure to transcript (231 ms in Moonshine), and the neural-speech interruption test took 257 ms (250 ms in Moonshine). These figures exclude the approximately 650 ms of silence Jarvin waits for before closing the segment, so the estimated delay from the last spoken sound to transcript in the first improved run was roughly 0.9 s. These single-run timings are diagnostic, not a p95 benchmark. A live source-build UI check opened Jarvin, showed the floating pet, dragged it about 55 px left and 63 px up, and clicked it to restore the app.

A subsequent interruption pass widened the barge-in window to include queued synthesis and active model replies before audio becomes audible. Automatic listening continues alongside an unfinished typed draft; a spoken request is submitted separately and leaves the draft intact. The isolated floating-pet test stopped Piper playback, cancelled the old streaming response, submitted the follow-up, and retained a separate draft. It does not prove that the physical microphone can distinguish the user's voice from speaker echo.

The pet's Stop reply menu action now stops both the model run and renderer audio, including playback after the model run has ended. Starting manual microphone recording also interrupts the old reply and waits for cancellation before processing the new words. Isolated Electron checks passed both the pet stop signal and a manual-microphone interruption through the real local recognizer and neural voice.

Qwen3-VL passed 6/6 generated-screen checks: four locations (logo, taskbar icon, paragraph, navigation), a short code read, and rejecting a missing button. Cold first request: 8.76 s; subsequent requests: 0.22–0.37 s. Cached identical images make this a favorable benchmark; real changing screenshots can take longer.

Qwen 3.5 with the full 87-tool catalogue: a warm typing-tool decision took 1.20 s; first text for a conversational reply took 0.64 s. The first cold screen-tool choice took 11.11 s. These are model decisions, not completed desktop tasks. A generated-screen agent test with the full catalogue chose locate, click and observe in the correct order and verified the changed result; no real mouse was used in that test.

For a clear desktop request in Assistant view, task routing presented 39 relevant tools. The prompt fell from about 7,257 to 3,466 tokens in a comparable test; a warm typing-tool decision took 0.94 s. Qwen also completed locate → click → observe in a generated-screen task with this routed catalogue. Mixed and coding requests keep the full catalogue. This is a narrow routing rule, not a general learned tool planner.

The Windows input helper previously started a new PowerShell process for every operation. A persistent per-task JSON worker started in 1,341 ms, then handled repeated ping requests in 1–3 ms. This measures protocol overhead only, not the time to recognize a visual target or complete an action. It is disposed when a task ends, and cancellation never replays uncertain input.

## Behavior and boundaries

- Listening starts automatically when voice is enabled and the model is installed. No wake phrase or hands-free mode is needed. Mute remains available.
- Minimize or close keeps Jarvin running with its pet. Right-click the pet to reopen, mute, stop, or quit. Quitting ends the session.
- Before desktop observation/input, Jarvin hides its main window, waits for the desktop to settle, then acts. It does not reopen over the target after every action.
- The pet's glow reflects microphone levels; its eyes and arms reflect observed screen/control activity.
- While the pet floats, Jarvin samples the primary screen about every 600 ms and keeps one latest image in memory. Background sampling pauses during speech and transcription so it does not delay voice; visual tools can still request a fresh image. A screen task can use the recent frame; clicks require a fresh image, and focus/input invalidates the buffer. The vision model interprets frames when a task needs them, rather than inferring on every frame. No continuous video file is saved. Visual targets are short-lived and tied to the observed display and foreground window. Input outcomes still need visual verification.
- Model/voice inference can stay local while Chrome accesses the internet. This is not a Windows service, and it does not continue after quitting or through a locked/sleeping session.

Reproduce speech measurements with `scripts/speech-model-compare.mjs` (PowerShell 7 needed for the Indian English voices), `npm run check:qwen-voice`, and `scripts/vision-model-compare.ts`. Qwen's comparison script and results are in `scratchpad/asr-bench`; other machine-readable results are in `.test-out`.

Model sources: [Moonshine ONNX](https://huggingface.co/onnx-community/moonshine-base-ONNX), [Distil Whisper](https://huggingface.co/distil-whisper/distil-small.en), [Qwen3-ASR](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), [sherpa-onnx Qwen support](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_non_streaming_qwen3_asr.js), [Qwen3-VL](https://ollama.com/library/qwen3-vl), and [Silero VAD](https://github.com/snakers4/silero-vad). See model cards for licenses. The speech-recognition model weights are cached in the user's app-data folder; the small Silero detection model and its MIT notice are bundled in `assets/voice`.
