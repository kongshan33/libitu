"""Source-transcript reference measurements, without independent ASR verification."""
from hashlib import sha256
import json
from pathlib import Path

from app.config import Settings
from app.schemas.practice_analysis import ContentCheck, VoiceProsody
from app.schemas.reference import Alignment, Measurements
from app.services.acoustics import engine
from app.services.acoustics.practice_prosody import word_measurements

REFERENCE_PIPELINE = "reference-source-transcript-v3-progressive"


def reference_identity(settings: Settings) -> dict:
    # Separate reference policy from the shared measurement engine and learner ASR.
    return {"engine": engine.engine_identity(settings), "reference_pipeline": REFERENCE_PIPELINE}


def reference_version(settings: Settings) -> str:
    return sha256(json.dumps(reference_identity(settings), sort_keys=True).encode()).hexdigest()


def compatible_reference(reference: dict, learner_snapshot: dict) -> bool:
    snapshot = reference.get("snapshot", {})
    if snapshot.get("engine") != learner_snapshot.get("engine"):
        return False
    pipeline = snapshot.get("reference_pipeline")
    return pipeline in (REFERENCE_PIPELINE, "reference-source-transcript-v2") or (pipeline is None
        and snapshot.get("asr_sha256") == learner_snapshot.get("asr_sha256"))


def reference_content_available(voice: VoiceProsody) -> bool:
    # Historical ASR-verified references remain readable without relabelling them.
    return voice.content.status in ("source_transcript", "matched")


def align_reference(audio: Path, text: str, origin: float, measurements: Measurements,
                    directory: Path, settings: Settings) -> tuple[Alignment, VoiceProsody]:
    content = ContentCheck(status="source_transcript", reason="source_transcript_not_asr_verified")
    if any(issue in measurements.quality_issues for issue in ("insufficient_speech", "low_energy", "clipping")):
        alignment = Alignment(status="unavailable", reason="insufficient_audio_quality")
    else:
        alignment = engine.align(audio, text, origin, directory, settings)
        if alignment.status == "aligned":
            reason = alignment_quality(alignment, text, origin, measurements)
            if reason:
                alignment = Alignment(status="unavailable", reason=reason)
    words = word_measurements(alignment, measurements) if alignment.status == "aligned" else []
    for word in words:
        word.start_sec = max(0, word.start_sec - origin)
        word.end_sec = max(0, word.end_sec - origin)
    voice = VoiceProsody(content=content, alignment_status=alignment.status,
        quality_issues=measurements.quality_issues, words=words)
    if alignment.status == "aligned":
        from app.services.acoustics.signal_prosody import analyze_signal, mfa_boundaries
        voice.rhythm_signal = analyze_signal(measurements, mfa_boundaries(alignment, origin=origin),
                                             "mfa", origin=origin, alignment=alignment)
    return alignment, voice


def alignment_quality(alignment: Alignment, text: str, origin: float, measurements: Measurements) -> str | None:
    words, phones = alignment.words, alignment.phones
    if not words or not phones or [t for w in words for t in engine.tokens(w.label or "")] != engine.tokens(text):
        return "reference_alignment_incomplete"
    # Keep sequence, bounds and duration checks independent of ASR. These checks
    # detect malformed timing, not whether every caption word was actually spoken.
    end = origin + measurements.duration_sec
    for intervals in (words, phones):
        previous = origin
        for interval in intervals:
            if interval.start_sec < previous - .001 or interval.start_sec < origin - .001 or interval.end_sec > end + .02:
                return "reference_alignment_invalid"
            previous = interval.end_sec
    if any(not .025 <= w.end_sec - w.start_sec <= 3 for w in words):
        return "reference_alignment_invalid"
    for word in words:
        contained = [p for p in phones if p.start_sec >= word.start_sec - .001 and p.end_sec <= word.end_sec + .001]
        if not contained or abs(contained[0].start_sec - word.start_sec) > .02 \
                or abs(contained[-1].end_sec - word.end_sec) > .02 \
                or any(abs(a.end_sec-b.start_sec) > .02 for a, b in zip(contained, contained[1:])):
            return "reference_alignment_incomplete"
    return None


def analyze_reference(audio: Path, text: str, directory: Path, settings: Settings) -> VoiceProsody:
    """Compatibility path for registered files without cached sentence prosody."""
    from app.services.acoustics.audio import RATE
    frames, speech, samples = engine.extract(audio, settings)
    measurements = engine.sentence_measurements(frames, speech, samples, 0, len(samples) / RATE)
    return align_reference(audio, text, 0, measurements, directory, settings)[1]
