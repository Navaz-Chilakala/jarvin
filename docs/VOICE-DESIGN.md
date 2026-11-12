# Reliable voice for Jarvin: design note

12 November 2026. Nothing in this note is built yet. It answers one request: speech must be understood correctly, noise must be ignored, Jarvin must not stop for stray sound, the user must be able to stop it, and the user's voice must win when Jarvin is talking.

## What is wrong today

| Problem the user sees | Cause found |
|---|---|
| "I say one thing, it hears another." | **The recognizer changes between sessions without saying so.** Windows Smart App Control blocks parts of the Qwen3-ASR engine on some launches and not on others (blocked 10 Nov 22:35, loading again on 12 Nov, a different file of it blocked at 08:43 the same morning). When it is blocked, Jarvin silently falls back to distil-small.en, a much weaker recognizer. So accuracy depends on luck at start-up. |
| The name is misheard. | Recognizers do not know the word "Jarvin". On the same test clip two of the three fallback models wrote "Jarvan". Matching by sound hides this but also lets in near-names. |
| Sounds become requests, or cut Jarvin off. | Speech is detected by loudness only. Anything loud enough is sent to the recognizer, and recognizers invent words for noise. |
| No measurement on the user's voice. | Every accuracy number so far comes from computer-generated speech. Published tests show model size is not a safe guide for Indian-accented English: one study measured Whisper small at 17.6% errors, medium at 13.2% and large-v3 at 19.0% on Indian-accent clips. Only a test on the user's own voice can choose the model. |

Measured on this laptop (7.1 s test sentence, CPU): moonshine-base 0.7 s, whisper-base.en 1.7 s, distil-small.en 3.6 s; Qwen3-ASR 1.6 s on a 2.6 s sentence when it loads. Running Whisper on the graphics card through DirectML crashed in a first try, so the plan assumes the CPU.

## How others solve it

- **Layered gates, not one.** Production voice assistants chain: wake word, then a neural voice detector, then recognition, then a turn decision. Each layer removes a different kind of mistake.
- **Neural voice detection.** Silero VAD (about 2 MB) is the common open choice for telling speech from noise; loudness thresholds are the known weak point.
- **A dedicated wake-word model.** Assistants do not transcribe everything and look for the name. A tiny always-on model listens only for the phrase. The open-source openWakeWord project ships a ready-made **"hey jarvis"** model, with a stated target of fewer than 0.5 false triggers per hour.
- **Interruptions.** Standard practice: keep listening while speaking, use echo cancellation so the assistant does not hear itself, stop speech at once on a real interruption, and treat a false interruption as worse than a slightly late one.
- **Push-to-talk.** Dictation apps that must never mis-trigger (hold a key, speak, release) avoid the whole problem. It is the most reliable input there is.
- **Recognizer checks.** Whisper-family models report how sure they are. The usual rule is to discard a result that is both "probably no speech" and low-confidence, and to remove silence before recognition.

Sources are listed at the end.

## Design

### Principle

Jarvin acts only when three independent things agree: the microphone is on, the wake phrase was detected by a model built for that, and the recognizer is confident about the words. Stopping is the one thing made easy on purpose.

### The five layers

1. **Microphone switch** (built). Off means no audio is read at all.
2. **Voice detector.** Replace the loudness threshold with Silero VAD run directly on the signed runtime Jarvin already ships (the model file is already in the app). Only audio it scores as speech goes further. Fans, typing, music beds and door slams stop here.
3. **Wake phrase by a dedicated model.** Add openWakeWord's "hey jarvis" detector, also on the signed runtime. It replaces "transcribe everything, then look for the name". Result: the name no longer depends on how the recognizer spells it, and nothing is transcribed until the phrase is heard. "Hey Jarvin" and "Hey Jarvis" sound alike to it; this must be measured on the user's voice (see step 0).
4. **Recognition with one known engine.** Jarvin states on screen which recognizer is active and never switches silently. The engine is chosen by measurement on the user's voice (step 0), from: Qwen3-ASR (if Windows lets it load reliably), Whisper small.en / medium.en / large-v3-turbo, distil-small.en, Moonshine. A result is dropped, not acted on, when the model reports low confidence, when it is a known noise phrase ("thank you", "you", "bye"), or when it is empty.
5. **Turn rules.** One fixed table (below). No timers that quietly change the rules.

### Turn rules

| Jarvin is… | You say "Hey Jarvis, …" | You say "stop" | Any other speech or sound |
|---|---|---|---|
| Idle, mic on | Captures the request, shows the words it heard, acts | Nothing to stop | Ignored |
| Capturing your request | (already listening) | Cancels the capture | Part of the request until you pause |
| Working on a task | Stops the task and takes the new request | Stops the task | Ignored; work continues |
| Speaking | Stops speaking at once and takes the request | Stops speaking | Ignored; it keeps speaking |
| Mic off | Ignored | Ignored | Ignored |

Two additions that make stopping dependable:

- **"Stop" gets its own fast path.** Besides the wake phrase, the wake-word layer also listens for "stop" while Jarvin is working or speaking, so stopping does not wait for a full transcription (today that takes 2 to 9 seconds).
- **A stop that always works without voice:** the existing shortcut Ctrl+Alt+J, the pet's right-click Stop, and clicking the pet's mic button.

### What you see

- Before acting, Jarvin shows "Heard: …" for about a second. A wrong hearing is visible before anything happens.
- The mic button shows the real state: off, waiting for "Hey Jarvis", capturing, working, speaking.
- The voice status line names the active recognizer.

### Push-to-talk as a second way in

Hold a key (or hold the pet's mic button), speak, release. No wake phrase, no voice detector, no false triggers; the recording is exactly what was said. It suits noisy rooms and exact dictation. It works alongside the wake phrase, not instead of it.

### Optional: internet recognition

The most accurate recognizers for accented English are online services. Jarvin is set to offline-only today, and this design keeps it that way. If offline accuracy on the user's voice is still not good enough after step 0, an online recognizer can be offered as an explicit choice: audio would leave the PC, it needs an account key, and it costs money per minute.

## Build order

| Step | What | Why first |
|---|---|---|
| 0 | **Voice test.** The user reads about 20 short sentences once (5 minutes). Jarvin saves them as a private test set and runs every installed recognizer and the wake-word model on them: errors per model, time per model, wake phrase hits and misses. | Every later choice depends on it. Without it the model is a guess. |
| 1 | Show the active recognizer; stop silent switching; pick the winner of step 0. | Removes the session-to-session randomness, the largest cause found. |
| 2 | Silero voice detector in place of the loudness threshold. | Removes most stray-sound captures. |
| 3 | Dedicated "hey jarvis" wake model and the fast "stop" path. | Makes the name and stop reliable and quick. |
| 4 | Confidence and noise-phrase filter; "Heard: …" preview. | Stops wrong hearings from becoming actions. |
| 5 | Push-to-talk. | The fallback that cannot mis-trigger. |
| 6 | Re-run the voice test, plus a 30-minute room test (TV on, typing, talking) counting false triggers. Target: no false action in 30 minutes, and the wake phrase caught at least 19 times out of 20. | Proves it, with numbers, on this user and this room. |

## Open questions

- Does openWakeWord's "hey jarvis" model fire reliably on "Hey Jarvin" in the user's voice? Step 0 answers it. If not, the phrase becomes "Hey Jarvis", or a custom model is trained.
- Can Qwen3-ASR be made to load every time? Only code signing fixes the Windows block for good. Until then the design must not depend on it.
- How much echo comes back through the laptop speakers. Echo cancellation is already on; headphones remove the question entirely.

## Sources

- Open ASR leaderboard snapshot and model comparisons: https://benchmarklist.com/benchmarks/open_asr_leaderboard/ , https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks , https://openwhispr.com/blog/parakeet-vs-whisper-vs-nemotron
- Whisper sizes on Indian-accented English: https://arxiv.org/pdf/2604.21276
- Voice pipeline, turn-taking and barge-in practice: https://www.assemblyai.com/blog/whats-inside-a-voice-agent-pipeline , https://picovoice.ai/guide/voice-agents/voice-ux-latency-turn-taking/ , https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/ , https://dev.to/vaiu-ai/how-to-build-reliable-barge-in-logic-for-voice-agents-k1a
- openWakeWord and its "hey jarvis" model: https://pypi.org/project/openwakeword , https://github.com/dscripka/openWakeWord
- Whisper confidence values and silence handling: https://www.popularai.org/p/whisper-hallucinations-during-silence , https://notebook-dg9.pages.dev/kb/ai/asr/troubleshooting/
