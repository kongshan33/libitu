# Local reference word and phone alignment

`alignLocalReference` sends decoded PCM and the existing Sound dictionary annotation
to a dedicated browser Worker. It never uploads audio, phones or results. The
worker resamples to 16 kHz, normalizes the waveform and runs the pinned English
Charsiu INT8 model through the existing ONNX Runtime Web 1.22.0 WASM runtime.
The model is fetched from this application's origin and checked by size and SHA-256.

## Prepare the model

Run `node scripts/prepare-alignment.mjs --download` from `apps/web` once. The
123,010,803-byte model is cached in ignored `.models/local-alignment-v1/` and copied
to ignored `public/acoustic-assets/local-alignment-v1/`. A pre-downloaded model can
be supplied through `LIBITU_ALIGNMENT_MODEL`. Both paths verify the same pinned
hash. Ordinary preparation without `--download` makes no network requests and
leaves basic playback, recording, VAD and pitch analysis available if this optional
model has not been prepared. Ship its public directory with the web deployment.

Model: `charsiu/en_w2v2_fc_10ms`; INT8 export:
`mnaoizyyy/charsiu-js-models`, revision
`d22b7e9b99d5fb2bed3e10fa8014917c2a4403dd`.
SHA-256: `53f5b163ea1f9f995ecf38bfc91994411505d8a970b912cf6b5544c8f28e916d`.
The export's model card explicitly licenses the English model as MIT. The original
Charsiu project and its JS export implementation use MIT; see the distributed
`THIRD_PARTY_LICENSES.txt`. No G2P model or third-party JS is fetched at runtime.

## Output and limits

The model emits 42 phone-class logits every 10 ms (39 stressless CMU phones,
silence, unknown and padding). This is a frame-classification model, not a character
CTC model. A bounded monotonic dynamic program aligns its posteriors to a graph
containing every supported dictionary pronunciation for each word. Stress-only
variants collapse to one acoustic path. Phone and word indices survive adjacent
identical labels and repeated words. Adjacent identical phones abstain unless an
observed silence separates them; an indistinguishable label run cannot locate
their internal boundary. Words compressed to one 10 ms frame also abstain. Output
labels retain unambiguous dictionary stress, which is not measured speaker stress.
When stress-only alternatives collapse, stress digits are omitted as unknown.

Silence runs of at least four frames are removed before alignment and restored to
their actual locations afterward, following Charsiu's silence treatment. A gap
requires a transition between target phones; if no complete path satisfies this,
the result is unreliable rather than reporting a phone duration including
silence. Model frame times are kept on the native 10 ms grid; the final
convolution remainder is not stretched into the last phone.

`ready` means a complete acoustic path was obtained under the supplied text and
dictionary assumptions. `contentVerification` always remains
`not_independently_verified`, and `phoneLabels` is always `dictionary_targets`.
It does not recognize what was actually said, validate pronunciation, identify
realized allophones, measure stress or establish pronunciation correctness.
Changing the caption can still force a misleading path; independent ASR/content
verification and human evaluation remain separate work.

The worker supports 0.4–20-second sentences and at most 120 tokens, 1,500 graph
states and 3,000,000 backtrace cells. Missing or unsupported dictionary phones,
insufficient speech, failed paths and ambiguous silence crossings abstain.
Audio quieter than -60 dBFS is rejected before normalization. As a gross-failure
guard, paths with less than 10% agreement with frame argmax labels or mean selected
phone posterior below 0.05 abstain. These are uncalibrated rejection heuristics,
not confidence or accuracy estimates; passing them does not verify the text.
Errors, cancellation and the 180-second deadline terminate the worker. There is
no timed word split, uniform phone split or caption-timestamp fallback.

## Verification

`tests/local-alignment-engine.test.mjs` checks alternate pronunciations, repeated
words/phones, real silence gaps, abstention, invalid input and source-label
provenance using controlled emission matrices. A real Chrome smoke on 2026-09-26
loaded this exact model in ONNX Runtime Web 1.22.0 WASM: a 2.737-second upstream
synthetic example produced `[1,272,42]` logits and nine words/31 phones in about
3.2 seconds after about 2.2 seconds of model startup. Its boundaries differed by
at most 10 ms from the upstream Python fixture. This proves runtime/decoder
compatibility on this machine, not human boundary accuracy or mobile performance.

Two additional macOS synthetic-English cases aligned all 10 and 11 words. The
first retained separate `had had` occurrences; the second selected different
dictionary alternatives for `to` and `for`. Silence abstained. A deliberately
unrelated five-word transcript paired with the second recording still produced a
complete forced path. That counterexample is why even `ready` results retain
`not_independently_verified`; this experiment does not justify treating a
successful forced path as a content match. No thresholds were tuned to that case.

A 19.159-second concatenation of the synthetic upstream clip ran in the same
single-threaded Chrome WASM runtime in about 34.2 seconds and emitted 1,914 frames.
This exercises inference near the 20-second input bound on this desktop; peak RAM
was not measured and slower/mobile devices may still time out or lack memory.
