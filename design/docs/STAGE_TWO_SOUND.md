# Stage 2 Sound guide

Updated: 2026-09-09

## Delivered scope

M4a adds a source-bound Sound guide in a three-layer workspace with separate Sound, Rhythm and Melody tabs. The initial implementation is **dictionary lookup plus deterministic phonology rules**. No LLM is called, no audio is sent to the endpoint and no extra API key is needed. The earlier architectural principle still applies: a future LLM can reason about text/phonemes, but it must not label its reasoning as acoustic evidence.

M4b is not complete. ASR-gated MFA word/phone alignment and paired vowel/boundary timing are now implemented for permitted server file references. Experimental measurement resemblance is available in saved results; validated allophone detectors and realized-phenomenon verdicts remain unavailable. See [the 2026-09-23 increment](STAGE_TWO_SOUND_COMPARISON.md). The dictionary/rule guide below remains a separate source of conditional suggestions.

The accepted [file-reference target](STAGE_TWO_FILE_REFERENCE_ARCHITECTURE.md) changes acquisition and processing order, not this evidence boundary. Build the selected-segment file/asset foundation before expanding M4b. A downloaded, decoded, or force-aligned reference does not by itself establish any Sound phenomenon; LLM rule inference remains text-only and separate from acoustic detection.

## Data flow

1. Stage 2 chooses an existing shared sentence ID.
2. `GET /api/blueprints/{content_id}/sentences/{sentence_id}/sound` resolves that sentence from the same current blueprint view as the reader. No submitted text is trusted as the source.
3. The server tokenizes the exact sentence, looks up the pinned full CMU dictionary and applies bounded rules. It caches a versioned derived view without changing the persisted semantic blueprint.
4. The web validates content/sentence identity, full sentence text, token offsets and candidate spans before rendering. Offsets are UTF-16 code units with exclusive ends; they are not audio timestamps or the source transcript's whitespace-token ranges.
5. Filters and suggestion buttons select an occurrence in the text without controlling the player. The detail shows possible pronunciation, conditions, and distinct Reference/Your voice evidence.
6. The existing microphone analysis runs once and is shared by Sound evidence status and both Rhythm/Melody views. The views also share the existing reference result/cache. Selecting another layer never reruns analysis or invents phone-level evidence.

The browser keeps an LRU cache of 20 guides for the current practice. Its key includes rule version, content, sentence ID and exact text. Navigation cancels requests and rejects late responses; failure is retryable and not cached. Exit or refresh clears the cache. The fetch has a 15-second deadline. Guide reads do not upload audio or create attempt/history records.

## Three-layer interaction

The workspace follows `design/prototypes/toneflow_stage2_three_layer.html` through three persistent tabs, synchronized left-side shortcuts, a central layer canvas and a right-side focus. A left-side shortcut selects its layer and scrolls the workspace into view. The active tab uses roving focus with Left/Right wrapping and Home/End navigation. Inactive panels remain mounted but hidden, preserving the current sentence, player, recording, Sound filter/selection/revealed hints and cached data. The original video, playback, microphone and practice-audio controls remain mounted in a shared operation area above the workspace. Desktop places video/playback left and reference setup/recording right; mobile stacks them in that order.

Sound's central canvas shows one card per returned token, with dictionary IPA, source text and conditional phenomenon badges. Unknown IPA stays unavailable and multiple readings remain visible. Filters narrow the candidate badges and source choices; selecting a word or a candidate updates the exact source highlight and the right-side possible phone change, explanation, conditions and separate Reference/Your voice evidence. A badge is a rule candidate, never a detected sound or score.

Hide text covers the words and their IPA and hides source-revealing sentence copies, candidate labels, dictionary details and the selected explanation. While Sound is active, the practice prompt and selected sentence-directory entry are also concealed. Each covered card can reveal one word through a positional, keyboard-accessible button; Reveal all restores the sentence. Changing tabs preserves these hints, while choosing another sentence resets them. These controls do not play, pause, record or request another guide.

Saved results now use paired Rhythm text, solid dictionary-stress dots, word durations and inline pause bars; Melody overlays word-aligned relative pitch with gaps preserved. The duplicate Rhythm speech/pause timeline is removed. Empty plots contain no illustrative measurements. Actual sentence emphasis and nuclear stress remain unevaluated. Local-only measurements retain their fallback views; see `STAGE_TWO_SOUND_COMPARISON.md` for the current comparison contract.

## Initial rule catalogue

Every result is `status: candidate`, conditional on the listed context. Dictionary stress is lexical stress, not prominence measured in the utterance. Punctuation between words prevents cross-word candidates. Phone rules skip unknown or ambiguous dictionary readings.

| Rule | Conservative context | Display boundary |
|---|---|---|
| Linking | Known word ends in a consonant sound and the next begins with a vowel sound | May connect within a phrase; spelling alone does not establish the boundary |
| Weak form | Small function-word whitelist, with unstressed grammatical-use conditions | Never infer emphasis from word position; ambiguous grammatical roles are excluded |
| Flap | Within one word: primary-stressed vowel, `/t/` or `/d/`, then an unstressed vowel | Optional `[ɾ]`; excludes a following stressed vowel and cross-word cases |
| Assimilation | Word-final `/t/` or `/d/` followed by `/j/` in `you`/`your`, with one dictionary reading | Possible `[tʃ]`/`[dʒ]`; not obligatory |
| Elision | Word ends in consonant + `/t/` or `/d/`, followed by a consonant | Optional cluster simplification; no missing consonant is claimed from audio |

The rule engine intentionally sacrifices coverage. An unknown name, abbreviation, number, different dictionary reading or unsupported context can have connected speech even when no suggestion is returned. Multi-letter uppercase forms and uppercase `A` stay unresolved; `SAT` is not silently pronounced as `sat`, while the pronoun `I` remains supported. Proper-name spelling and dictionary stress do not establish the speaker's intended reading. Rules do not identify a speaker's accent, correct the sentence, or grade a valid unmodified pronunciation.

Requests over 6,000 UTF-16 code units are rejected with a recoverable limit message. Token processing is bounded to 300 and candidate output to 80; partial coverage is reported with warnings and the full source sentence stays unchanged. `coverage.known` counts tokens with one dictionary reading; ambiguous tokens are shown separately. The server LRU holds 128 results keyed by rule version, lexicon version, content, sentence and text hash. The dictionary and rule limits are deployment contracts, not a new sentence-splitting policy.

## Sound evidence and detector release gate

| Available input | Sound result |
|---|---|
| Text and dictionary only | Candidate; no recorded evidence |
| No corresponding recording | No recording; unevaluated |
| Pending/failed M3 analysis | Unevaluated, with a recovery/status explanation |
| Too little usable speech | Unevaluated due to insufficient recording evidence |
| Usable M3 speech/pitch features | Unevaluated: aligned phoneme evidence and validated detector still absent |

M4b requires these steps before enabling a detector:

1. Establish content consistency and independent alignment for the reference and learner recording. A forced aligner fitting the expected transcript is not by itself proof that the learner spoke those words.
2. Version the alignment and detector evidence by content, sentence, recording and model. Analyze the authorized recording before its temporary bytes are released; do not reconstruct phone boundaries from caption interpolation or normalized chart positions.
3. Implement separate evidence for each phenomenon. For example, linking needs aligned boundary continuity; weak forms need the relevant vowel/duration evidence and contextual stress; a flap needs short coronal constriction evidence; assimilation needs phone contrasts; elision needs evidence distinguishing deletion from unreleased or masked stops. A burst threshold alone cannot settle these questions.
4. Evaluate each detector on human-labelled examples and counterexamples with speaker/source-disjoint splits, different microphones and real learner accents. Record precision, recall, abstention/coverage, agreement and uncertainty; set release thresholds from the intended feedback cost. Synthetic signals or passing code tests do not validate learner feedback.
5. Release only the validated phenomena. Low-quality, unaligned, ambiguous and out-of-domain recordings must abstain. No candidate, absence of a burst, or missing detector result is an automatic pronunciation error.

Server-side learner persistence and permitted reference ingestion are now implemented in the later increments documented in `STAGE_TWO_PRACTICE_ANALYSIS.md` and `STAGE_TWO_SERVER_REFERENCE.md`. The dictionary endpoint itself remains text-only and does not change the YouTube reference-media boundary.

## Dictionary provenance and references

Full upstream dictionary data and its original license are vendored under `apps/api/app/data/cmudict`; that directory records the pinned commit/checksum. The parser is application code; the GPL Python `cmudict` wrapper is not a runtime dependency. Deploy the dictionary data with the API. Missing/corrupted data produces an explicit unavailable response, not guessed pronunciation.

- [CMUdict upstream](https://github.com/cmusphinx/cmudict): pronunciation data and acknowledged omissions/inconsistencies. Dictionary entries are a lexical reference, not an acoustic measurement.
- [Parrell & Narayanan (2018), Explaining Coronal Reduction](https://sail.usc.edu/span/pdfs/parrell2018explaining.pdf): prosodic context and variability in coronal reduction motivate conservative flap candidates.
- [British Council, Connected speech part 2](https://www.teachingenglish.org.uk/professional-development/teachers/knowing-subject/connected-speech-part-2): consonant/vowel linking as a teaching category. The app's General American rules are a deliberately bounded implementation, not an exhaustive transcription system.

No 95% accuracy claim is established for these annotations or for future Sound detectors.
