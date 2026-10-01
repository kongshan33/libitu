# Shared sentence boundaries

Updated: 2026-09-13

## Caption-first timing (delivered 2026-09-13)

An early top-frame MAIN observer passively reads the YouTube player's own
current-video English JSON3 fetch/XHR responses, without constructing/replaying
signed requests or generating tokens. It keeps sanitized current-video tracks
only (four tracks / 4 MiB / 15-minute TTL), with at most two simultaneous response
copies and a two-second copy deadline. Cancelling a copy never aborts the player.
Stage 1 opens before handoff acquisition; its injected reader checks the observer
cache once without page timers, with a 2.5-second outer injection deadline.
Failed initial acquisition retains the existing bounded DOM/server-caption
fallback. Block-only JSON3 remains usable. Request-start source identities and
navigation generations reject late responses, including A-to-B-to-A navigation.

Missing observers, unobserved captions, player request failures, empty/invalid/
oversized responses, copy timeouts and extension communication errors have
distinct safe statuses. Installation after a request completed cannot recover
that body: reload the updated extension and refresh the source page. Enable or
re-enable English captions to let the player request them before Libitu Retry;
Libitu does not automatically toggle captions or start playback. This is a
best-effort page integration and may be affected by YouTube or other extensions.
No acquisition status alone guarantees usable word timing.

`caption_track` carries sanitized `tStartMs`, `dDurationMs`, `segs[].utf8` and
optional `tOffsetMs`, plus source video/language/kind and rolling-event markers.
Limits are 2 MiB, 10,000 events, 50,000 total segments, 12,000 segments per event
and 240,000 text characters. Raw offsets are not expanded to fabricated words.
The server's existing caption provider now preserves fractional starts and cue
durations under `youtube-snippets-v1`; this is not a word-timed ASR integration.

Rich sources produce `sentence-v3-*`; plain-text sources retain `sentence-v2-*`.
Both stages share one sentence layer and the same normalized source-token indices.
`timing_source` distinguishes `caption_word_offsets`, `caption_event_estimate`
and `caption_estimate`. Optional `word_timings` retain each eligible token's text,
global index, source event/segment indices and caption-derived start. Ends are
nullable and explicitly marked `next_word_estimate` or `event_end_estimate`.
A missing first-segment offset becomes zero only when other offsets establish
fine-grained timing. Missing interior offsets, multiword/split-token segments,
invalid or nonmonotonic offsets, and ambiguous rolling/overlapping updates do not
acquire invented word times. Repeated text is not globally deduplicated.

Display duration is not speech duration. Navigation estimates are bounded by
following usable event/word anchors so an earlier cue cannot swallow a later
sentence. A start-to-start delta is never treated as measured silence or a reason
to mechanically split a complete sentence. Without acoustic ends this is still
approximate playback, not a guarantee against clipping the last spoken sound.

Stage 1/2 use a shared 50 ms local word clock and half-open highlight intervals;
only changed active-word classes are mutated. Existing 100 ms sentence/controller
telemetry remains separate. Pause, unresolved seek, hidden document and exit clear
word highlights. Unknown, overlapping or over-two-second estimated word intervals
do not highlight continuously; this UI abstention threshold is not silence
detection and does not shorten stored timing. Corpus selection/highlights and
Sound's hidden-text mode are preserved. Stage 2 code loads dynamically; the new
caption path does not wait for reference capture, audio models, ASR or alignment.

Availability notices sit beneath Stage 1 subtitle controls and Stage 2's selected
sentence. They count only words passing the same `qualifyCaptionWords` gate used
by the text renderer. No eligible words shows `Word timing unavailable`; mixed
coverage shows `Partial word timing`. With usable data, switched-off highlighting
and hidden practice text get separate explanations. Empty/loading-without-text
states do not announce a missing capability, and streaming notices describe the
current captions rather than promising future word times. Coverage depends on
memoized caption data, not the playback clock. These notices neither reveal
concealed source text nor initiate any fetch, reanalysis or media action.

Source metadata persists in the existing private YouTube source envelope and
queue payload. New blueprints retain words and a separate `caption_fingerprint`.
Timing-only upgrades can derive a new sentence view from cached semantic analysis
only when normalized source words match exactly. That eight-entry process cache
does not rewrite the original blueprint or personal corpus. First cold reads can
still incur source retrieval/local formatting; old coarse data cannot invent
previously missing offsets. Actual changed spoken text requires new analysis.
Optional timing/source-comparison read failures retain an already available
blueprint or ready job, without triggering reanalysis. Logs include only the
exception type, not signed URLs or source payloads. Required job/blueprint reads
still surface their own failures; this is not an offline-storage guarantee.

Final JSON uses gzip level 3 above 2 KiB when the client accepts it. SSE is excluded
from compression. The web opts into `compact_word_timings=true`: unchanged word
metadata is omitted after its first transmission within that connection, while
sentence identity/text/bounds and other preview data remain explicit. Clients
restore only an exact same-row match; explicit null/empty lists clear evidence.
Reconnect starts complete, and polling/final reads remain complete. Older clients
that do not opt in still receive full snapshots.

### Recovery for old ready caches

A ready `contentId` URL previously loaded its existing blueprint without invoking
caption acquisition. Focusing a reused extension handoff also kept its original
capture. Missing timing in these caches therefore did not prove that the YouTube
source lacked word offsets. A read-only check of the learner's Lisa Su video on
2026-09-13 found no rich track in either stored source cache, and no word timings
in its blueprint. Its source and blueprint had the same 2,635 normalized words.

Recovery is separate from initial blueprint loading and the local availability
notice. Once a ready YouTube blueprint with no usable word timing is visible,
the web requests fresh JSON3 through a source-bound extension message, independent
of `handoffId`. The extension reads only an already open matching watch tab. It
does not open tabs, use DOM fallback, invoke media capture, or persist signed
requests. Missing extensions/tabs, timeouts and unusable tracks leave cached
playback available, with explicit retry instead of an automatic retry loop.

`POST /api/content/{content_id}/caption-timing` accepts a sanitized track only for
the same video and language and the exact normalized spoken sequence in both
the existing source and blueprint. It validates usable timing before saving,
preserves the original transcript/public metadata and semantic documents, and
returns a derived timed blueprint without creating a job or invoking DeepSeek.
Partial source extracts and changed words are rejected rather than partially
overwriting the video cache. The user's complete JSON3 events prove the parser's
word-offset support; the truncated final event is not treated as a full track.

The web applies a recovered view in the paused Stage 1 reader. Stage 2 retains
its active sentence IDs, bounds, local take and reference session until the
learner returns to Stage 1; its recovery message makes that step explicit.
Source-bound Sound requests remain compatible with the old sentence snapshot.
Changing source or leaving the page cancels the client recovery lifecycle and
prevents late results from replacing another video's data. Aborting a request
does not imply that a server write already in progress was rolled back.

This is a local-development cache repair path, not a guarantee that YouTube's
advertised endpoint is available on every video. The updated unpacked extension
must be reloaded in Chrome, and the Libitu page reloaded to install its new bridge.
No extension permission, audio pipeline, model dependency or database migration
is added by recovery.

### Synthetic performance probe

In-memory 500-event × 8-word JSON3, one event every three seconds (25 minutes),
reliable punctuation, no syntax/model inference or external requests. Imports
and fixture construction excluded; one warmup per path, then five interleaved
runs. Plain first-preview/total medians: **28.43/127.48 ms**; rich:
**161.13/282.93 ms**. This isolates processing overhead, not real page loading.

The raw rich track was 153,720 bytes versus 26,799 bytes of plain captions.
Serialized rich sentence rows were 945,079 bytes, or 78,960 bytes with gzip level 3;
plain rows were 188,503/12,584 bytes. Word metadata alone added 764,576 bytes to
each repeated complete snapshot. Twenty such unchanged retransmissions would
repeat about 14.6 MiB, motivating the connection-level deduplication. Actual SSE
polling coalesces formatter callbacks; these counts are not observed live traffic.

### Verification boundary

Initial caption-first checks on 2026-09-13 passed: root `pnpm lint`, `pnpm test` and
`pnpm build`; 241 API, 151 web and 49 extension unit tests (441 total).
Mocked browser regressions passed for Stage 1 at 1440/390 px, Stage 2 sentence
navigation at 1440/768/390 px and Sound at 1440/390 px. Desktop/mobile screenshots
were inspected for word highlighting, sentence navigation and hidden-text layout.
The availability-notice follow-up added nine unit cases and
`apps/web/tests/caption-timing-status.browser.mjs`. Its 1440/390 px checks passed
with exit 0: unavailable/partial/full timing, off/hidden display settings,
sentence changes, concealed-text isolation, preserved playback, no extra API or
acoustic-asset requests, and no horizontal overflow. Notice screenshots were
visually inspected in both stages.

The old-cache recovery follow-up passed root lint/build/test: 267 API, 161 web
and 61 extension unit tests (489 total). The real JSON3 excerpt's first five
complete events retain 14 word starts; 13 intervals pass the highlighting gate,
while the final word's long estimated end abstains. Full-source comparison rejects
using that short excerpt to replace an unrelated full-video source. Persistence
tests use a fake repository/HTTP transport, including uncertain commit and retry;
they are not a live database-write verification. An actual unpacked extension
with intercepted source fixtures passed the independent old-handoff path,
block-only response, source checks, timeout/retry and missing-tab behavior.
Existing timing-status and synthetic-microphone recording regressions passed at
1440/390 px with clean process exits. The real local Lisa Su cache remained
readable and showed the recovery timeout/retry state; the running user-browser
extension had not yet returned the new fresh-caption response. Live acquisition
is not claimed complete until that extension/page reload and source check pass.
`caption-timing-recovery.browser.mjs` passed all six current-version desktop/mobile
cases with exit 0: cache-first rendering, one bounded automatic read, paused
Stage 1 application, preserved Stage 2 microphone wait/recorder/player/selection,
explicit exit before application, absent-extension retry and rejected late
cross-content replies. It makes no resolve/job/ASR request. Pending-update layouts
were visually checked at both widths. This focused test does not enable or claim
to validate the separately developed audio-buffer capture flow. Earlier checks
also verified retention of the preceding reference-session implementation.
After parallel changes settled, final shared-workspace type/lint/build checks
passed and the root test rerun passed 509 tests (267 API, 174 web, 68 extension),
including tests added by the separate audio-buffer work.

The passive-player-response revision passed root lint/build and a forced uncached
test rerun: 267 API, 179 web and 110 extension tests (556 total), including 23
observer tests. Actual unpacked-extension fixtures exercise fetch and XHR
text/JSON with intact original bodies, document-start home-to-watch navigation,
late installation, TTL, old-handoff independence and cross-video rejection.
The source tab is explicitly asserted to be inactive: testing exposed timer
throttling in the earlier local wait, which was replaced by one immediate cache
snapshot. Eight requests across the two temporary browser profiles came only
from explicit player-fixture calls, with no extra acquisition on Libitu Retry.
The web recovery fixture passed eight 1440/390 px scenarios, including nine
observer/offset status messages at each width with visible Retry and no overflow;
screenshots were inspected. All external browser boundaries were intercepted.
Live `g2A6-5_EY7w` recovery with the updated extension remains pending the source
page/extension reload and a real response; these fixtures are not that evidence.

Automated coverage includes capture timing/fallback and SPA source isolation,
schema/private-RPC/queue roundtrips, cache upgrades without semantic reanalysis,
worker preview/final identity, millisecond handling, ambiguous-word abstention,
following-event navigation bounds, compression, SSE reconnect semantics and
optional source-read failure recovery.
Browser regressions use mocked YouTube/API boundaries. Real YouTube request
availability, provider timestamp errors and the learner's `think about` example
still require source-specific validation. No audio was downloaded and no paid
model was called during this verification.

## Delivered behavior

Stage 1 subtitles and Stage 2 practice use the same finalized sentence rows.
There is one sentence layer. Long sentences are not divided into thought groups,
child units, or arbitrary word-count slices. The local syntax model supplies
conservative evidence for joining incomplete model-punctuation candidates, not a
claim of complete semantic understanding.

New queue-mode processing follows:

1. Parse caption rows and continuations, retaining repeated rows and time anchors.
2. Remove only the existing standalone English filler tokens.
3. Preserve reliably punctuated source text, bypassing both models; otherwise
   restore punctuation using sherpa-onnx in overlapping windows.
4. Keep one provisional candidate and examine the next candidate with the small
   English spaCy dependency parser. Join only supported incomplete boundaries.
5. Emit confirmed sentences incrementally, retaining their source token ranges,
   IDs, approximate start/end, and boundary provenance through finalization.
6. Use the same text for semantic analysis, evidence validation, Stage 1 display,
   and Stage 2 playback selection.

The 30/35-word guards of the old formatter no longer define sentence endings in
this chain. Inference is bounded independently from output sentence length.
The deterministic inline blueprint generator remains a development baseline;
its display is upgraded through the same legacy-view boundary as older caches.

## Contract and identity

`TranscriptLine` and `AnalysisTranscriptPreviewLine` carry compatible optional
metadata: `segmentation_version`, `id`, `source_token_start`, `source_token_end`,
`start_ms`, `end_ms`, `boundary_source`, and `boundary_confidence`.

Token ranges are half-open positions in the normalized source whitespace-token
sequence. They are not phonetic tokens or forced alignment. A fingerprint of
source words, caption anchors, estimated intervals, and segmentation version plus
the token range identifies a sentence within the source. Repeated words at
different positions receive different identities. Identical caption timestamps
do not collapse independent sentences.

The segment builder consumes estimated sentence starts so segment selection
cannot truncate a shared sentence. Stage 2 uses server rows directly. Completely
legacy frontend responses retain their prior sentence navigation fallback; mixed
or damaged metadata preserves complete row text and degrades timing confidence.

## Streaming and failure handling

The first confirmed sentence can be emitted immediately; later callbacks batch
eight rows to avoid quadratic publication work. The worker retains its existing
network throttle. At most the unconfirmed tail may change. A later punctuation
failure falls back only over the unseen suffix, preserving all emitted rows.
Syntax loading or inference failure keeps punctuation/source candidates usable.
Marks in an untrusted raw suffix after punctuation failure are labelled unresolved,
not attributed to successful model inference.

Unpunctuated text without usable models can remain one unresolved span. An
unfinished video tail is not given an invented full stop. Long rows can delay
confirmation until a candidate boundary and lookahead exist; first-subtitle
latency is therefore measured, not guaranteed by a fixed window duration.

## Caches and compatibility

The segmentation version is separate from DeepSeek's semantic `analysis_version`.
New blueprints persist full sentence metadata through the existing document
contract; no database migration is required.

Older blueprints get a derived sentence view on read, cached for up to eight
blueprints per API process. The original persisted document, semantic analysis,
and personal corpus snapshots remain unchanged. Selected corpus highlighting is
reapplied to the derived text. Repeat reads of unchanged data reuse that view;
the first read after a process restart incurs local formatting/model-load cost.

Legacy display rows have lost internal caption anchors and punctuation
provenance. Their marks are treated as model candidates and their times remain
estimates. Reading an old cache cannot reconstruct acoustic timing or recover
the original punctuation provenance. No DeepSeek request is made by this upgrade.

## Runtime and evaluation

Dependencies are pinned to spaCy 3.8.16 and `en_core_web_sm` 3.8.0, installed by
`uv sync --extra dev`. The worker preloads the CPU pipeline before dequeuing jobs.
NER and lemmatization are excluded; tagger, parser, tok2vec, and attribute_ruler
provide the syntax features. Model access is synchronized across worker threads.
No GPU, runtime model download, or media processing is involved.

Run from `apps/api`:

```bash
uv run python scripts/benchmark_sentences.py --transcript /path/to/captions.txt --runs 3
```

The benchmark separates model cold loading, direct syntax-decision time, first
preview, total formatting, and process RSS. It compares complete metadata in
successive previews and checks lexical-token conservation separately from casing.
`--stdin` avoids saving source captions; constructed repeated prose is useful for
timing only and is not a real-video accuracy evaluation.

### Local measurements, 2026-09-09

Environment: macOS x86_64, Python 3.13.11, pinned models above. The source was the
existing public English caption cache for **Big Think Interview With Peter Thiel
| Big Think**, read without updating content, blueprints, or corpus. No DeepSeek
request, caption-provider request, or media download was made.

| Input / execution path | First formatter preview | Complete formatting | Syntax work |
| --- | --- | --- | --- |
| Original punctuated captions: 17,443 characters, 231 rows, 2,871 lexical tokens | 35–39 ms warm | 114–128 ms warm | Bypassed; 117 sentences |
| Punctuation removed from the same real captions: 17,141 characters, 2,860 lexical tokens | 83 ms warm | 6.11 s warm | About 1.26 s for 142 boundary decisions; 131 sentences |

The second row is a **transformed real source**, not independently obtained ASR
output. The token-count difference between inputs comes from stripping punctuation;
each run conserves its own normalized source tokens and ordering. Capitalization
can be normalized, as in the prior formatter. Both paths preserved complete SSE
metadata prefixes. The timings above are local probes, not production guarantees
or an accuracy score.

The final transformed-source row is one warm probe, not a median. Its models were
preheated with a short constructed input; fetching the stored source is outside
the measurement. An immediately preceding version measured 61 ms to first preview,
2.44 s total, and 0.55 s of syntax decisions, before the final explicit-subject
guard. That probe measured cold syntax loading at about 1.82 s and first preview
including Python/import/model cold start at about 2.57 s. Other probes under
concurrent development load took 2.45–6.31 s to load syntax and 7–17 s for the whole
transcript. This variability is why direct syntax timing is reported separately
instead of attributing a noisy total-time difference solely to NLP or claiming
the last guard caused the elapsed-time change.
The worker preloads the model; old-cache upgrades in a newly started API process
can still pay this cold cost on their first read.

The instrumented full-pipeline probe peaked at about 157 MiB RSS. An earlier same-input
comparison measured about 74 MiB without syntax versus 158 MiB with syntax; these
are whole-process values, not isolated model allocations. A trusted-source process
that loaded neither model used about 32 MiB. The English model wheel is 12.2 MiB;
the 27 newly installed dependency payloads total approximately 91 MiB on this
machine. There is no per-request NLP API charge; CPU, memory, and deployment
storage remain real operating costs.

Boundary review included 30 sampled source boundaries and the joins proposed by
the transformed-source run. It exposed false joins around independent `If`/`That`
clauses, adverbial `on`, and an explicit subject following `And`; these became
conservative guards and minimized regressions. All six disputed boundary cases
are preserved by the final probe. Its 12 remaining joins are not claimed to be
12 correctly repaired semantic boundaries. This is one video's regression exercise,
not representative labelled accuracy. Residual punctuation errors, speech restarts,
and conservative missed joins remain possible.

### Verification and rollout

- `pnpm test`: 98 API, 51 Web, and 6 extension tests passed. Existing Node
  experimental/module warnings and the Starlette TestClient deprecation warning
  remain unrelated to sentence formatting.
- `pnpm lint`, `pnpm build`, and `git diff --check` passed.
- Browser fixtures passed Stage 1 at 1440/390 px and Stage 2 at 1440/768/390 px.
  Checks cover shared-timestamp rows, stable preview/final DOM identity, full server
  text, URL restoration, playback ranges, and responsive layout. Screenshots were
  inspected. The player and APIs are mocked, so this is not acoustic validation.
  The mock run also logged Clerk session-refresh warnings; live login was not
  validated or changed by this sentence-formatting task.
- The installed-model fixture has 47 boundary pairs: 46 desired decisions and one
  explicitly recorded conservative missed join (`And cooked dinner`). The test
  permits that documented abstention without relabelling the desired boundary.
- Dependencies have been installed and verified locally. Apply the locked Python
  dependencies and restart the API and worker when rolling out. No database
  migration, analysis-version bump, or semantic-cache deletion is needed
  for this code change. No deployment was performed in this task.

## Known limits

- Dependency parsing is a conservative merge aid. It cannot reliably reconstruct
  every disfluency, sentence restart, answer fragment, or incorrectly transcribed
  word. Broad multi-video human-labelled evaluation remains future work.
- Boundary confidence describes provenance/heuristics, not calibrated probability.
- Caption interpolation and the estimated final tail remain approximate; this
  work adds neither acoustic alignment nor pronunciation scoring.
- Archived corpus evidence remains a historical snapshot even if display
  punctuation is later repaired.
- Server-process memory and cold legacy reads need measurement on deployment
  hardware; development-machine timing is not a production SLA.
