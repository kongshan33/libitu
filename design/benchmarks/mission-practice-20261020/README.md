# Feedback v3 synthetic provider probe

On 2026-10-20, `verify_speaking_review.py` made one real DeepSeek request using
one synthetic target, one synthetic assistant opportunity and one synthetic
final USER reply. It called `assess_feedback` directly, without a database,
Mission creation, Gemini, audio playback or learner data.

The fixture records a fully presented opportunity to use “to be fair”. The
synthetic reply states that the other team needs two days to finish its review.
Those presentation receipts are fixtures; this run does not verify actual
playback, teaching quality or learning effects.

The first run is preserved in [review-events.json](review-events.json):

- Rubric `speaking-rubric-v2`, analysis `speaking-feedback-v3`.
- One provider request, HTTP 200, 4,065.41 ms.
- Report `partial`; optional suggestions `unavailable`, zero accepted.
- One assessed USER turn, zero used primary targets; source unchanged.
- No database reads or writes, and no persistent fixture requiring cleanup.

Provider usage was unavailable in this first run. The initial trace captured
transport bytes before HTTPX decoding and could not parse the envelope. The
response encoding was not recorded, so this does not establish why the report
was partial. No raw provider response was retained, and the script was not
automatically retried.

The tracing implementation was subsequently changed to capture bounded decoded
bytes and safe schema diagnostics. Offline tests cover plain and gzip responses,
the one-request transport limit, and removal of provider text and secrets from
diagnostics. This tracing change does not itself verify another live result.

One explicitly authorized diagnostic request was then made, preserved in
[review-diagnostic-events.json](review-diagnostic-events.json):

- One request, HTTP 200, 3,955.02 ms; finish reason `stop`.
- 3,273 prompt tokens and 872 completion tokens, 4,145 total.
- All three model-generated dimension objects contained a disallowed extra
  field, so strict validation rejected the assessment. Arbitrary field names
  were redacted from diagnostics.
- Report `partial`; suggestions `unavailable`, zero accepted. No suggestions
  were counted as user use, and the source was unchanged.

The prompt was subsequently clarified to enumerate the exact allowed dimension
and criterion fields and to prohibit dimension-level ratings, scores, labels and
basis fields. Offline tests preserve strict rejection and the single-call limit.

A final, separately authorized verification after that prompt change is preserved
in [review-final-events.json](review-final-events.json):

- One request, HTTP 200, 3,913.8 ms; finish reason `stop`.
- 3,327 prompt tokens and 878 completion tokens, 4,205 total.
- The same three dimension-level `extra_forbidden` errors remained. The unknown
  fields were outside the safe diagnostic name whitelist.
- Report `partial`; suggestions `unavailable`, zero accepted and zero user uses.

The prompt adjustment therefore has **no live success claim**. Strict schema
validation remains in force; an unvalidated assessment is not displayed as a
complete report. No further request was made. Across all three explicitly
authorized requests, no database state was created or modified.

To run an explicitly authorized new probe:

```bash
cd apps/api
.venv/bin/python scripts/verify_speaking_review.py --run-live --ipv4 \
  --output ../../design/benchmarks/mission-practice-20261020/new-review-events.json
```

Each invocation allows one provider request and a 45-second total deadline.
There is no provider, network or content repair retry. Suggested rewrites, when
accepted, remain AI suggestions and are excluded from usage counts and scores.

The separate hosted parent/second-round planning verification is documented in
[practice-verification.md](practice-verification.md).
