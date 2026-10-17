"""Durable learner processing with independent content checks and fenced writes."""
from datetime import datetime, timezone
from hashlib import sha256
import logging
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from time import monotonic

import httpx
from app.integrations.reference_repository import get_reference_repository
from app.schemas.practice_analysis import ANALYSIS_VERSION, GATED_ANALYSIS_VERSION, ProsodyResult, VoiceProsody, WordCheck
from app.services.acoustics.comparison import assess, assess_checked
from app.services.acoustics import engine, audio_cache
from app.services.acoustics.sources import is_browser_capture
from app.services.acoustics.audio import AudioFailure, crop
from app.services.acoustics.practice_prosody import analyze_voice, normalize_take, check_learner_words, analyze_checked_voice
from app.services.acoustics.word_check import analysis_scope, checked_tokens, content_check
from app.schemas.reference import Measurements
from app.services.acoustics.signal_prosody import analyze_signal, learner_boundaries
from app.services.acoustics.reference_prosody import analyze_reference, compatible_reference, reference_content_available
from app.services.practice_analysis_service import reference_for
from app.workers.acoustic_worker import LeaseLost

log = logging.getLogger(__name__)


def process(repo, row, token, settings, lane="combined"):
    stopped, lost = Event(), Event()

    def heartbeat():
        while not stopped.wait(settings.acoustic_lease_seconds / 3):
            try:
                if not repo.fenced(row["id"], token, "heartbeat", {"seconds": settings.acoustic_lease_seconds}):
                    lost.set()
                    return
            except httpx.HTTPError:
                lost.set()
                return

    thread = Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        if row["analysis_version"] not in (ANALYSIS_VERSION, GATED_ANALYSIS_VERSION) or row["snapshot"]["engine"] != engine.engine_identity(settings) or row["snapshot"]["asr_sha256"] != settings.practice_asr_model_sha256:
            raise AudioFailure("worker_version_mismatch")
        attempt = repo.get_attempt(row["user_id"], row["id"])
        if not attempt or attempt.get("deleted_at"):
            raise LeaseLost()
        with TemporaryDirectory(prefix="libitu-take-") as tmp:
            work = Path(tmp)
            wav = work / "learner.wav"
            # Durable checkpoints already contain all learner evidence needed for comparison.
            if not (row["analysis_version"] == GATED_ANALYSIS_VERSION
                    and row.get("word_check") and row.get("learner_checkpoint")):
                data = repo.read_audio(row)
                if len(data) != row["input_bytes"] or sha256(data).hexdigest() != row["input_sha256"]:
                    raise AudioFailure("recording_integrity_failed")
                source = work / "input"
                source.write_bytes(data)
                normalize_take(source, wav)
            if row["analysis_version"] == GATED_ANALYSIS_VERSION:
                process_checked(repo, row, token, settings, attempt, wav, work, lost, lane)
                return
            if lane == "fast":
                raise AudioFailure("legacy_analysis_requires_fine_worker")
            learner = analyze_voice(wav, row["snapshot"]["text"], work / "learner-alignment", settings)
            result = ProsodyResult(learner=learner, reason="reference_unavailable")
            reference = reference_for(attempt, row.get("reference_id"))
            if learner.content.status != "matched" or learner.alignment_status != "aligned":
                result.reason = "learner_content_or_alignment_unavailable"
            elif reference and reference.get('state') not in ('failed', 'cancelled'):
                if not reference["audio_ready"] or reference.get('state') in ('awaiting_upload', 'queued', 'processing'):
                    raise AudioFailure("reference_not_ready")
                cached = next((r.get('prosody') for r in reference.get('results', []) if r['sentence_id'] == row['snapshot'].get('sentence_id')), None)
                compatible = compatible_reference(reference, row['snapshot'])
                if cached and compatible:
                    result.reference = VoiceProsody.model_validate(cached)
                elif not is_browser_capture(reference) and reference.get('state') not in ('failed', 'cancelled'):
                    # Backward compatibility for pre-cache registered file references.
                    reference_bytes = get_reference_repository().read_audio(reference)
                    if sha256(reference_bytes).hexdigest() != reference["audio_sha256"]:
                        raise AudioFailure("reference_integrity_failed")
                    original, sentence = work / "reference.wav", work / "reference-sentence.wav"
                    original.write_bytes(reference_bytes)
                    crop(original, sentence, (attempt["start_ms"] - reference["start_ms"]) / 1000,
                         (attempt["end_ms"] - reference["start_ms"]) / 1000)
                    result.reference = analyze_reference(sentence, row["snapshot"]["text"], work / "reference-alignment", settings)
                if result.reference and reference_content_available(result.reference) and result.reference.alignment_status == "aligned" \
                    and [w.text for w in learner.words] == [w.text for w in result.reference.words]:
                    result.comparison, result.reason = "available", None
                else:
                    result.reason = "reference_content_or_alignment_unavailable"
            # Source revocation and sentence changes during processing cannot publish a comparison.
            if result.reference and reference_for(attempt, row.get("reference_id")) is None:
                result.reference, result.comparison, result.reason = None, "unavailable", "reference_unavailable"
            result.assessment = assess(result, row["snapshot"]["text"])
            state = "completed" if learner.content.status == "matched" and learner.alignment_status == "aligned" else "needs_review"
            if lost.is_set() or not repo.fenced(row["id"], token, "finish", {"state": state, "result": result.model_dump(mode="json")}):
                raise LeaseLost()
    except LeaseLost:
        log.info("Practice analysis lease no longer active: %s", row["id"])
    except AudioFailure as error:
        repo.fenced(row["id"], token, "retry" if error.code == "reference_not_ready" else "finish", {"state": "failed", "error_code": error.code})
    except httpx.HTTPError:
        # If storage is still down, lease expiry recovers the job.
        try:
            repo.fenced(row["id"], token, "retry", {"error_code": "storage_unavailable"})
        except httpx.HTTPError:
            pass
    except Exception:
        log.error("Practice analysis failed: %s", row["id"])
        repo.fenced(row["id"], token, "finish", {"state": "failed", "error_code": "analysis_failed"})
    finally:
        stopped.set()
        thread.join(timeout=1)


def process_checked(repo, row, token, settings, attempt, wav, work, lost, lane="combined"):
    def write(action, data):
        started = monotonic()
        if lost.is_set() or not repo.fenced(row["id"], token, action, data):
            raise LeaseLost()
        log.info("Practice timing id=%s lane=%s stage=%s seconds=%.3f", row["id"], lane, action + ":" + data.get("phase", ""), monotonic()-started)

    if lane == "fine" and not row.get("word_check"):
        raise AudioFailure("fast_checkpoint_missing")
    if row.get("word_check"):
        check = WordCheck.model_validate(row["word_check"])
        if check.source_tokens != checked_tokens(row["snapshot"]["text"]):
            raise AudioFailure("word_check_snapshot_mismatch")
    else:
        write("checkpoint", {"phase": "checking_words"})
        started = monotonic()
        check = check_learner_words(wav, row["snapshot"]["text"], settings)
        log.info("Practice timing id=%s lane=%s stage=asr_word_check seconds=%.3f", row["id"], lane, monotonic()-started)
        write("checkpoint", {"phase": "word_check_complete", "word_check": check.model_dump(mode="json")})
    scope = analysis_scope(check)
    if scope == "none":
        result = ProsodyResult(version=GATED_ANALYSIS_VERSION,
            learner=VoiceProsody(content=content_check(check), alignment_status="not_run"),
            reason="match_threshold_not_met" if check.status == "reliable" else check.reason)
        write("finish", {"state": "completed" if check.status == "reliable" else "needs_review",
                         "phase": "finished", "result": result.model_dump(mode="json")})
        return
    pending = {"phase": "analyzing_sound" if scope == "sound_only" else "analyzing_all"}
    if lane != "fast":
        write("checkpoint", pending)
    measurements = None
    if scope == "all_layers" and row["snapshot"].get("progressive_version") == "server-prominence-v1":
        if row.get("acoustic_checkpoint"):
            measurements = Measurements.model_validate(row["acoustic_checkpoint"])
        else:
            if lane == "fine":
                raise AudioFailure("fast_checkpoint_missing")
            started = monotonic()
            frames, speech, samples = engine.extract(wav, settings)
            log.info("Practice timing id=%s lane=%s stage=signal_extraction seconds=%.3f", row["id"], lane, monotonic()-started)
            measurements = engine.sentence_measurements(frames, speech, samples, 0, len(samples)/16000)
            # Persist full energy/F0 before MFA and before analysis audio cleanup.
            # A retry consumes this checkpoint without repeating extraction.
            if lane == "fast":
                pending["acoustic_checkpoint"] = measurements.model_dump(mode="json")
            else:
                write("checkpoint", {"acoustic_checkpoint": measurements.model_dump(mode="json")})
        if not row.get("coarse_checkpoint"):
            started = monotonic()
            coarse = analyze_signal(measurements, learner_boundaries(check), "asr_word")
            log.info("Practice timing id=%s lane=%s stage=cwt seconds=%.3f", row["id"], lane, monotonic()-started)
            if lane == "fast":
                pending.update(phase="coarse_ready", coarse_checkpoint=coarse.model_dump(mode="json"))
            else:
                write("checkpoint", {"phase": "coarse_ready", "coarse_checkpoint": coarse.model_dump(mode="json")})
        elif lane == "fast":
            pending["phase"] = "coarse_ready"
    if lane == "fast":
        write("publish_handoff", pending)
        return
    if row.get("learner_checkpoint"):
        learner = VoiceProsody.model_validate(row["learner_checkpoint"])
    else:
        learner = (analyze_checked_voice(wav, check, scope, work / "learner-alignment", settings, measurements=measurements)
                   if measurements is not None else analyze_checked_voice(wav, check, scope, work / "learner-alignment", settings))
        write("checkpoint", {"learner_checkpoint": learner.model_dump(mode="json")})
    reference = reference_for(attempt, row.get("reference_id"))
    if learner.alignment_status == "aligned" and reference and reference.get("state") not in ("failed", "cancelled") and (
            not reference["audio_ready"] or reference.get("state") in ("awaiting_upload", "queued", "processing")):
        write("wait_reference", {})
        return
    result = ProsodyResult(version=GATED_ANALYSIS_VERSION, learner=learner, reason="reference_unavailable")
    if learner.alignment_status != "aligned":
        result.reason = "learner_alignment_unavailable"
    elif reference and reference.get("state") not in ("failed", "cancelled"):
        cached = next((item.get("prosody") for item in reference.get("results", [])
                       if item["sentence_id"] == row["snapshot"].get("sentence_id")), None)
        compatible = compatible_reference(reference, row["snapshot"])
        if cached and compatible:
            result.reference = VoiceProsody.model_validate(cached)
        elif not is_browser_capture(reference):
            data = get_reference_repository().read_audio(reference)
            if sha256(data).hexdigest() != reference["audio_sha256"]:
                raise AudioFailure("reference_integrity_failed")
            original, sentence = work / "reference.wav", work / "reference-sentence.wav"
            original.write_bytes(data)
            crop(original, sentence, (attempt["start_ms"]-reference["start_ms"])/1000,
                 (attempt["end_ms"]-reference["start_ms"])/1000)
            # Reference alignment uses source text, independently of learner word tiers.
            result.reference = analyze_reference(sentence, row["snapshot"]["text"], work / "reference-alignment", settings)
        ref = result.reference
        if ref and reference_content_available(ref) and ref.alignment_status == "aligned" \
                and len(ref.words) == check.source_count \
                and [t.normalized for w in ref.words for t in checked_tokens(w.text)] == [t.normalized for t in check.source_tokens]:
            result.comparison, result.reason = "available", None
        else:
            result.reason = "reference_content_or_alignment_unavailable"
    if result.reference and reference_for(attempt, row.get("reference_id")) is None:
        result.reference, result.comparison, result.reason = None, "unavailable", "reference_unavailable"
    result.assessment = assess_checked(result, check, scope)
    write("finish", {"state": "completed" if learner.alignment_status == "aligned" else "needs_review",
                     "phase": "finished", "result": result.model_dump(mode="json")})


def reconcile(repo):
    audio_cache.prune()
    now = datetime.now(timezone.utc)
    for row in repo.cleanup_candidates(now.isoformat()):
        if row["state"] not in ("completed", "needs_review", "deleted"):
            repo.control(row["user_id"], row["id"], "cancel")
        repo.remove_audio(row)
        repo.mark_clean(row, now.isoformat())


def main():
    raise SystemExit("Use app.workers.stage_two_worker --lane fast and --lane fine in separate processes.")


if __name__ == "__main__":
    main()
