"""Durable learner processing with independent content checks and fenced writes."""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import logging
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from uuid import uuid4

import httpx
from app.config import get_settings
from app.integrations.practice_analysis_repository import get_practice_analysis_repository
from app.integrations.reference_repository import get_reference_repository
from app.schemas.practice_analysis import ANALYSIS_VERSION, ProsodyResult, VoiceProsody
from app.services.acoustics.comparison import assess
from app.services.acoustics import engine
from app.services.acoustics.sources import is_browser_capture
from app.services.acoustics.audio import AudioFailure, crop
from app.services.acoustics.practice_prosody import analyze_voice, normalize_take
from app.services.acoustics.transcribe import verify_model
from app.services.practice_analysis_service import reference_for
from app.workers.acoustic_worker import LeaseLost

log = logging.getLogger(__name__)


def process(repo, row, token, settings):
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
        if row["analysis_version"] != ANALYSIS_VERSION or row["snapshot"]["engine"] != engine.engine_identity(settings) or row["snapshot"]["asr_sha256"] != settings.practice_asr_model_sha256:
            raise AudioFailure("worker_version_mismatch")
        attempt = repo.get_attempt(row["user_id"], row["id"])
        if not attempt or attempt.get("deleted_at"):
            raise LeaseLost()
        with TemporaryDirectory(prefix="libitu-take-") as tmp:
            work = Path(tmp)
            data = repo.read_audio(row)
            if len(data) != row["input_bytes"] or sha256(data).hexdigest() != row["input_sha256"]:
                raise AudioFailure("recording_integrity_failed")
            source, wav = work / "input", work / "learner.wav"
            source.write_bytes(data)
            normalize_take(source, wav)
            learner = analyze_voice(wav, row["snapshot"]["text"], work / "learner-alignment", settings)
            result = ProsodyResult(learner=learner, reason="reference_unavailable")
            reference = reference_for(attempt, row.get("reference_id"))
            if learner.content.status != "matched" or learner.alignment_status != "aligned":
                result.reason = "learner_content_or_alignment_unavailable"
            elif reference and reference.get('state') not in ('failed', 'cancelled'):
                if not reference["audio_ready"] or reference.get('state') in ('awaiting_upload', 'queued', 'processing'):
                    raise AudioFailure("reference_not_ready")
                cached = next((r.get('prosody') for r in reference.get('results', []) if r['sentence_id'] == row['snapshot'].get('sentence_id')), None)
                compatible = reference.get('snapshot', {}).get('engine') == row['snapshot']['engine'] \
                    and reference.get('snapshot', {}).get('asr_sha256') == row['snapshot']['asr_sha256']
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
                    result.reference = analyze_voice(sentence, row["snapshot"]["text"], work / "reference-alignment", settings)
                if result.reference and result.reference.content.status == "matched" and result.reference.alignment_status == "aligned" \
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


def reconcile(repo):
    now = datetime.now(timezone.utc)
    for row in repo.cleanup_candidates(now.isoformat()):
        if row["state"] not in ("completed", "needs_review", "deleted"):
            repo.control(row["user_id"], row["id"], "cancel")
        repo.remove_audio(row)
        repo.mark_clean(row, now.isoformat())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    repo, settings = get_practice_analysis_repository(), get_settings()
    if not repo:
        raise SystemExit("Configure Supabase before starting the practice analysis worker.")
    if not settings.practice_asr_model_path or not settings.practice_asr_model_sha256:
        raise SystemExit("Provision PRACTICE_ASR_MODEL_PATH and PRACTICE_ASR_MODEL_SHA256 before starting analysis.")
    verify_model(settings.practice_asr_model_path, settings.practice_asr_model_sha256)
    while True:
        try:
            reconcile(repo)
            token = str(uuid4())
            row = repo.claim(token, settings.acoustic_lease_seconds)
            if row:
                process(repo, row, token, settings)
                reconcile(repo)
        except httpx.HTTPError:
            log.warning("Practice storage unavailable; retrying.")
        if args.once:
            return
        Event().wait(settings.acoustic_poll_seconds)


if __name__ == "__main__":
    main()
