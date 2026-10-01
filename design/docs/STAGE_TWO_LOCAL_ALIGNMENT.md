# Browser reference word and phoneme alignment

Updated: 2026-09-26. This increment connects browser-captured reference audio to local word/phoneme timing and the Stage 2 three-layer display. It does not upload reference audio.

## Implemented path

1. Existing explicit Chrome capture supplies one continuous sentence clip from the bounded local PCM buffer. The web client now preserves its capture ID. The legacy sentence-capture path uses its unique request ID.
2. The page-level reference cache binds that clip to content ID, source URL, versioned sentence ID, exact text and source bounds. Silero/Pitchy produces its usual speech, pause and relative-pitch measurements first.
3. The client reads the sentence's existing CMU dictionary guide. Only this text-bound GET reaches the API. Audio decoding, model inference and alignment take place in the browser.
4. A separate Worker runs the pinned English Charsiu frame-classification model and a bounded monotonic alignment over dictionary phone targets. Word alternatives are constrained by the dictionary. Repeated words/phones retain their own target positions.
5. A result contains word and phone intervals, the chosen dictionary pronunciation, model version and explicit `not_independently_verified` content status. Its cache envelope includes exact sentence identity, capture ID and encoded-audio SHA-256. Its audio clock starts at the selected crop, not at video time zero.
6. Sound exposes target-phone timing; Rhythm uses acoustic word positions for reference pauses; Melody bins that reference's measured relative pitch within each word. A matching saved learner result supplies the other row without uploading the reference or mutating the saved server analysis.

## Evidence and display

- File-reference server results retain their existing priority and score provenance.
- Local aligned reference measurements remain visible before learner words are available. Learner-only measurements remain visible if local alignment fails.
- Local REF and saved YOU combine only when the current source/word sequence matches and the learner's independent content check and alignment succeeded. Mismatched/uncertain evidence stays separate.
- Dictionary phone labels retain lexical stress for the guide. They are alignment targets, not an independently recognized transcription or observed sentence emphasis.
- Local/server engine comparison does not borrow old scores or silently apply server thresholds. Cross-engine scores stay empty. Actual weak forms, flaps, elision, assimilation, glottal stops, H-dropping and voicing remain unevaluated.
- Missing pitch remains missing. VAD silence must map unambiguously to an adjacent-word boundary before receiving a textual pause marker.

## Runtime and lifecycle

The alignment model is approximately 123 MB and is served from this app's static origin. The client checks the pinned SHA-256 before creating its ONNX Runtime Web WASM session. Model assets may use the ordinary HTTP cache; reference audio and derived alignment are never written to browser storage or uploaded.

The worker limits one sentence to 20 seconds, 120 dictionary tokens, 1,500 graph states and 3,000,000 alignment cells. Unsupported text, unavailable dictionary phones, poor acoustic support and over-limit input report a reason instead of invented timing. Indistinguishable consecutive same-phone targets and degenerate boundaries must not become arbitrary precise intervals. Conflicting dictionary stress alternatives remain unknown. Basic listening, recording and existing VAD/F0 retain their existing limits and remain available.

Prepare the pinned model once from the repository root:

```bash
pnpm --filter @libitu/web prepare:alignment
```

`pnpm dev` and `pnpm build` verify/copy an already downloaded model without network access. A clean checkout without the model still supports basic practice and reports local alignment unavailable. An operator can set `LIBITU_ALIGNMENT_MODEL` to a pre-provisioned file matching the pinned size/hash. Assets live in ignored `.models` and `public/acoustic-assets` directories, not in source control. Model and code attribution are in `apps/web/features/stage-two/alignment/THIRD_PARTY_LICENSES.txt`.

The shared cache retains its bounds of 20 results, two raw clips and 12 MiB aggregate raw data. Alignment uses the same raw clip after basic analysis and releases it after success or a non-retryable result. A loading/runtime error can retain raw bytes for at most 60 seconds for explicit retry; cache pressure can release them sooner. Retrying alignment does not rerun or erase successful basic measurements. Source changes, invalidation and page exit abort work and fence late completions. Refresh clears local alignments and requires a new captured reference.

## Verification

Functional acceptance completed on 2026-09-26:

- Root `pnpm lint`, `pnpm build` and `pnpm test` passed: 230 web, 447 API and 112 extension tests (789 total). Unchanged API/extension tasks reused caches. Controlled-logit tests cover pronunciation alternatives, repeated targets, ambiguous same-phone boundaries and silence; cache/display tests cover source/capture identity, mismatches, missing evidence, independent failure, limits, cancellation and late results.
- `apps/web/tests/local-reference-alignment.browser.mjs` passed in Chrome at 1440 and 390 px with actual Silero/Pitchy/Charsiu inference on synthetic speech. Nine reference words and 30 target-phone intervals reached the page. Reference-only and compatible saved learner rows, Sound/Rhythm/Melody switching without repeated inference, source isolation, cache reuse and no page overflow passed; screenshots were inspected. Reference preparation generated no API writes or audio uploads. Only a separately consented learner recording used its existing upload flow.
- The browser test fixtures supply player/extension transport, identity and saved learner results. The local reference model and audio decoder are real; learner ASR/MFA is not exercised by this new browser suite. The 390 px run is a desktop Chrome viewport, not a physical-phone performance check. Existing file-reference desktop/mobile regression also passed.
- Separate real-model smoke checks processed repeated words and pronunciation alternatives and rejected silence. A 19.159-second input completed inference in about 34.2 seconds on this desktop; peak RAM was not measured. A short upstream synthetic example agreed within 10 ms with its Python fixture, which establishes implementation compatibility rather than human accuracy. See the runtime `alignment/README.md` for these checks.

A deliberately unrelated caption still produced a complete forced path in one smoke check. This is an explicit limit of caption-conditioned alignment: `ready` is not a content match or evidence of correct pronunciation. Live YouTube capture quality, human boundary accuracy, real-device performance and pronunciation assessment remain separate acceptance work. Implementation acceptance is tracked in `TASK.MD`.

## Relationship to file sources

Browser tab-capture permission and server media-source registration serve different purposes. Registered permitted files remain necessary for the current server reference-ingestion adapter. They are not a prerequisite for local captured-audio alignment or three-layer measurement display. The existing learner-analysis upload opt-in and optional playback-retention choice are unchanged.
