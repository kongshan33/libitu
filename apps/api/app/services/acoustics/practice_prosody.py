"""Descriptive word measurements; no sentence-stress classifier or correctness score."""
import math
from pathlib import Path
from statistics import median
import subprocess
import wave

from app.schemas.practice_analysis import AlignedPhone, ContentCheck, VoiceProsody, WordProsody
from app.services.acoustics import engine
from app.services.acoustics.audio import AudioFailure, RATE
from app.services.acoustics.transcribe import transcribe


def normalize_take(source: Path, target: Path) -> float:
    try:
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-i", str(source),
            "-t", "62", "-vn", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(target)],
            capture_output=True, check=True, timeout=90)
        with wave.open(str(target)) as audio:
            duration = audio.getnframes() / audio.getframerate()
        if not .15 <= duration <= 61:
            raise AudioFailure("recording_duration_invalid")
        return duration
    except (subprocess.SubprocessError, wave.Error, EOFError, FileNotFoundError) as error:
        raise AudioFailure("audio_decode_failed") from error


def check_content(text: str, recognized: dict) -> ContentCheck:
    actual = recognized.get("text", "")
    if not recognized.get("reliable") or not engine.tokens(actual):
        return ContentCheck(status="uncertain", transcript=actual, reason="recognition_uncertain")
    if engine.tokens(text) != engine.tokens(actual):
        return ContentCheck(status="mismatch", transcript=actual, reason="recognized_words_differ")
    return ContentCheck(status="matched", transcript=actual)


def word_measurements(alignment, measurements) -> list[WordProsody]:
    pitches = [f.f0_hz for f in measurements.frames if f.f0_hz is not None]
    base = median(pitches) if pitches and "insufficient_pitch" not in measurements.quality_issues else None
    words = []
    for index, word in enumerate(alignment.words):
        valid = [f.f0_hz for f in measurements.frames if word.start_sec <= f.time_sec < word.end_sec and f.f0_hz is not None]
        enough = base and len(valid) >= 5
        curve = []
        for n in range(5):
            start = word.start_sec + (word.end_sec - word.start_sec) * n / 5
            end = word.start_sec + (word.end_sec - word.start_sec) * (n + 1) / 5
            values = [f.f0_hz for f in measurements.frames if start <= f.time_sec < end and f.f0_hz is not None]
            curve.append(round(12 * math.log2(median(values) / base), 2) if enough and len(values) >= 2 else None)
        following = alignment.words[index + 1] if index + 1 < len(alignment.words) else None
        gaps = [p for p in measurements.pauses if following and word.end_sec <= p.start_sec + .08
                and p.end_sec <= following.start_sec + .08 and p.start_sec - word.end_sec <= .25
                and following.start_sec - p.end_sec <= .25]
        continuous = following and 0 <= following.start_sec - word.end_sec <= .15 and any(
            s.start_sec <= word.end_sec and following.start_sec <= s.end_sec for s in measurements.speech)
        phones = [p for p in alignment.phones if p.start_sec >= word.start_sec - .001 and p.end_sec <= word.end_sec + .001]
        # Require nearly complete, contiguous phone coverage before publishing durations.
        covered = phones and abs(phones[0].start_sec-word.start_sec) <= .02 and abs(phones[-1].end_sec-word.end_sec) <= .02 \
            and all(abs(a.end_sec-b.start_sec) <= .02 for a,b in zip(phones,phones[1:]))
        words.append(WordProsody(text=word.label or "", start_sec=word.start_sec, end_sec=word.end_sec,
            duration_ms=round((word.end_sec - word.start_sec) * 1000, 1),
            pause_after_ms=round((gaps[0].end_sec - gaps[0].start_sec) * 1000, 1) if len(gaps) == 1 else None,
            pitch_st=round(12 * math.log2(median(valid) / base), 2) if enough else None, pitch_curve_st=curve,
            phones=[AlignedPhone(label=p.label or "", duration_ms=round((p.end_sec-p.start_sec)*1000, 2)) for p in phones] if covered else [],
            boundary_pause_ms=round((gaps[0].end_sec-gaps[0].start_sec)*1000, 1) if len(gaps)==1 else 0 if continuous and not gaps else None))
    return words


def analyze_voice(audio: Path, text: str, directory: Path, settings) -> VoiceProsody:
    frames, speech, samples = engine.extract(audio, settings)
    measurements = engine.sentence_measurements(frames, speech, samples, 0, len(samples) / RATE)
    if any(issue in measurements.quality_issues for issue in ("insufficient_speech", "low_energy", "clipping")):
        return VoiceProsody(content=ContentCheck(status="uncertain", reason="insufficient_audio_quality"),
            alignment_status="unavailable", quality_issues=measurements.quality_issues)
    content = check_content(text, transcribe(audio, settings))
    if content.status != "matched":
        return VoiceProsody(content=content, alignment_status="not_run", quality_issues=measurements.quality_issues)
    aligned = engine.align(audio, text, 0, directory, settings)
    return VoiceProsody(content=content, alignment_status=aligned.status, quality_issues=measurements.quality_issues,
        words=word_measurements(aligned, measurements) if aligned.status == "aligned" else [])
