# Browser-local acoustic measurements

`client.ts` exports `analyzeLocalAudio(blob, signal?, window?)`; the optional window uses capture-relative milliseconds. Audio is decoded locally, validated, optionally trimmed, mixed to mono, and transferred to one dedicated Worker. Abort, completion, timeout, and failures release the AudioContext and terminate the worker. No raw media, feature data, or cloud inference request is sent by this module. Only static same-origin model/runtime assets are fetched.

The browser must support AudioContext, Worker, WebAssembly SIMD, and secure-context crypto. Decoded files are limited to 65 seconds and two channels; encoded input is limited to 32 MiB. The entire request has a 90-second deadline, including decoding/model initialization. Unsupported decoding or model/runtime failure returns an error rather than fabricated analysis. A cancelled decode may finish internally in the browser; it cannot start a worker or publish a result.

## Pinned assets

`pnpm --filter @libitu/web prepare:acoustics` verifies installed package versions and SHA-256 hashes, then copies assets to `public/acoustic-assets/local-acoustics-v1`. The web dev/build commands run it automatically. Generated binaries are ignored by Git; a fresh install/build recreates them without a model registry or key. Deploy the generated public directory with Next.js. The worker verifies the model hash again before loading. Changing model/runtime bytes requires a deliberate manifest/version update.

| Component | Version/source | SHA-256 / license |
|---|---|---|
| Silero V5 ONNX | `@ricky0123/vad-web@0.0.29/dist/silero_vad_v5.onnx` | `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`; Silero MIT |
| ORT WASM loader | `onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.mjs` | `30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8`; Microsoft MIT |
| ORT WASM binary | `onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm` | `71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4`; MIT + upstream third-party notices |
| Pitchy | `4.1.0` npm release | MIT in this pinned package; upstream main has a different license |

The checked-in `scripts/acoustic-licenses/onnxruntime-THIRD-PARTY-NOTICES.txt` is the unmodified upstream `v1.22.0/ThirdPartyNotices.txt` (SHA-256 `e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc`). Builds copy this notice alongside the binary without fetching it.

Initial model/runtime transfer is approximately 13 MiB before HTTP compression/cache. ORT runs single-threaded WASM in the worker; shared memory, WebGPU, and cross-origin isolation are not required. The VAD wrapper JavaScript is not used: our small adapter follows its V5 model's `input`, `state`, `sr`, `output`, and `stateN` contract (512 samples at 16 kHz; reset state per recording).

## Measurement semantics and limits

- Windowed-sinc low-pass resampling converts decoded mono PCM to 16 kHz. All output times refer to the trimmed audio, not video timestamps or acoustic word alignment.
- Silero V5 speech probabilities use 0.5 start / 0.35 end hysteresis, 160 ms minimum speech, and 160 ms quiet termination. Internal gaps of at least 200 ms count as pauses. These are engineering defaults, not validated teaching thresholds.
- Pitchy McLeod tracking uses 40 ms centered windows and 10 ms hops inside detected speech. Only 60–600 Hz estimates with clarity at least 0.85 and frame energy above −50 dBFS are retained. Unvoiced/unclear frames remain gaps. Relative pitch is `12 * log2(F0 / median F0)` separately for each speaker. The pitch range is the 90th–10th percentile span.
- Silence below −55 dBFS, duration below 500 ms, or less than 400 ms detected speech prevents comparison. Melody also requires at least 200 ms of accepted pitch and 15% of detected speech duration. Missing pitch alone still permits timing descriptions.
- `compareAcoustics` reports speech-span ratio, active-speech ratio, internal-pause count difference, and relative-pitch range difference. It does not output a score, assess words, detect flap/reduction/linking, infer stress, or claim that two recordings contain the same text. No unconstrained DTW or time-normalized contour similarity is treated as pronunciation evidence.
- Reference capture timing is approximate browser telemetry. Pauses may reflect content, breath, device dropout or VAD errors. Pitchy is a baseline, not a claim of best accuracy: low voices, breathy/creaky speech, noise and octave errors require real-speaker evaluation. Synthetic tests verify measurements and lifecycle only, not learner-scoring validity.

Primary references: [Silero](https://github.com/snakers4/silero-vad), [V5 browser adapter](https://github.com/ricky0123/vad), [ORT Web deployment](https://onnxruntime.ai/docs/tutorials/web/deploy.html), [Pitchy](https://github.com/ianprime0509/pitchy).
