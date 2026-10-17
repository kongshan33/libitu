"""Offline prominence hypothesis, never imported by the application workers.

Inspired by multi-scale F0/energy/duration analysis in Wavelet Prosody Toolkit;
an independent PyWavelets implementation, NOT its LOMA algorithm or a trained
stress detector. Scores are continuous, uncalibrated and recording-relative.
"""
from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path

import numpy as np
import pywt

VERSION = "rhythm-cwt-experiment-v1"
DT = .01
SCALES_SEC = np.geomspace(.06, .24, 13)
WEIGHTS = np.array([.4, .4, .2])  # pitch / energy / vowel duration; untrained
VOWELS = frozenset("AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW".split())


def _normalize(values: np.ndarray, floor: float) -> np.ndarray:
    return np.clip((values - np.median(values)) / max(float(np.std(values)), floor), -4, 4)


def _wavelet(signal: np.ndarray) -> np.ndarray:
    # Reflection avoids zero-padding discontinuities; edges remain uncertain.
    scales = SCALES_SEC / DT
    pad = int(np.ceil(scales[-1] * 8))
    coefficients, _ = pywt.cwt(np.pad(signal, pad, mode="reflect"), scales,
                             "mexh", sampling_period=DT, method="fft")
    # Remove sqrt(scale) amplitude bias before averaging over log-spaced scales.
    return coefficients[:, pad:-pad] / np.sqrt(scales[:, None])


def analyze(sample: dict, weights: np.ndarray = WEIGHTS) -> dict:
    """Consume sentence-relative MFA + FULL 10ms features; no audio/model work.

    Expects {alignment: {status,words,phones}, measurements: {...}}. Missing
    measurements are never reconstructed from five-point UI pitch summaries.
    """
    alignment, measurements = sample["alignment"], sample["measurements"]
    issues = list(measurements.get("quality_issues", []))
    if alignment["status"] != "aligned" or any(x in issues for x in (
            "insufficient_speech", "low_energy", "clipping")):
        return {"version": VERSION, "status": "uncertain", "reasons": issues or ["alignment_unavailable"], "words": []}
    frames = measurements["frames"]
    t = np.array([f["time_sec"] for f in frames], dtype=float)
    energy = np.array([f["energy_dbfs"] for f in frames], dtype=float)
    f0 = np.array([f["f0_hz"] if f["f0_hz"] is not None else np.nan for f in frames], dtype=float)
    if len(t) < 5 or not np.all(np.isfinite(t)) or not np.all(np.isfinite(energy)) \
            or not np.allclose(np.diff(t), DT, atol=1e-5) or abs(t[0]) > 1e-5:
        raise ValueError("Expected finite, sentence-relative, regular 10ms frames")
    if np.any(np.isinf(f0)) or np.any(f0[np.isfinite(f0)] <= 0):
        raise ValueError("Invalid F0")
    duration = measurements["duration_sec"]
    if not t[-1] < duration <= t[-1] + DT + 1e-4:
        raise ValueError("Frame coverage does not match sentence duration")
    words, phones = alignment["words"], alignment["phones"]
    if not words or not phones:
        return {"version": VERSION, "status": "uncertain", "reasons": ["missing_alignment"], "words": []}
    for intervals in (words, phones):
        end = 0.
        for interval in intervals:
            a, b = interval["start_sec"], interval["end_sec"]
            if not np.isfinite(a+b) or a < end - .001 or b <= a or b > duration + .02:
                raise ValueError("Invalid or non-relative alignment")
            end = b
    speech = np.zeros(len(t), dtype=bool)
    for w in words:
        speech |= (t >= w["start_sec"]) & (t < w["end_sec"])
    if np.count_nonzero(speech) < 5:
        return {"version": VERSION, "status": "uncertain", "reasons": ["insufficient_frames"], "words": []}
    voiced = np.isfinite(f0) & speech
    pitch = np.zeros(len(t))
    pitch_support = voiced.copy()
    if np.count_nonzero(voiced) >= 5:
        indices = np.flatnonzero(voiced)
        pitch[indices] = _normalize(12 * np.log2(f0[indices] / np.median(f0[indices])), 2.)
        # Only bridge short unvoiced gaps. No invented pitch across long pauses.
        for left, right in zip(indices, indices[1:]):
            if t[right] - t[left] <= .15 + 1e-6 and np.all(speech[left:right+1]):
                pitch[left:right+1] = np.linspace(pitch[left], pitch[right], right-left+1)
                pitch_support[left:right+1] = True
    intensity = np.zeros(len(t))
    intensity[speech] = _normalize(energy[speech], 3.)
    nuclei = [p for p in phones if (p.get("label") or "").rstrip("012") in VOWELS]
    lengths = np.array([p["end_sec"]-p["start_sec"] for p in nuclei])
    centers = np.array([(p["end_sec"]+p["start_sec"])/2 for p in nuclei])
    timing = np.zeros(len(t))
    if len(nuclei) >= 3:
        # Vowel nuclei avoid giving all long, many-syllable words higher scores.
        # Intrinsic vowel duration and phrase-final lengthening remain confounds.
        timing = np.interp(t, centers, _normalize(np.log(lengths), .25))
        timing[~speech] = 0
    features = np.array([pitch, intensity, timing])
    components = np.array([_wavelet(f) for f in features])
    scalogram = np.tensordot(weights, components, axes=1)
    curve = np.mean(scalogram, axis=0)
    word_results = []
    for i, w in enumerate(words):
        a, b = w["start_sec"], w["end_sec"]
        mask = (t >= a) & (t < b)
        contained = [p for p in phones if p["start_sec"] >= a-.001 and p["end_sec"] <= b+.001]
        vowel_mask = np.zeros(len(t), dtype=bool)
        for p in nuclei:
            if p["start_sec"] >= a-.001 and p["end_sec"] <= b+.001:
                vowel_mask |= (t >= p["start_sec"]) & (t < p["end_sec"])
        reasons = []
        if not contained or abs(contained[0]["start_sec"]-a) > .02 \
                or abs(contained[-1]["end_sec"]-b) > .02 \
                or any(abs(p["end_sec"]-q["start_sec"]) > .02 for p,q in zip(contained,contained[1:])):
            reasons.append("incomplete_phone_coverage")
        if not np.any(vowel_mask):
            reasons.append("no_vowel_nucleus")
        coverage = float(np.mean(voiced[mask])) if np.any(mask) else 0.
        if coverage < .2:
            reasons.append("low_pitch_coverage")
        if a < np.sqrt(2)*SCALES_SEC[-1] or duration-b < np.sqrt(2)*SCALES_SEC[-1]:
            reasons.append("wavelet_edge")
        if len(nuclei) < 3:
            reasons.append("insufficient_duration_context")
        valid = np.any(vowel_mask) and "incomplete_phone_coverage" not in reasons
        peak = int(np.flatnonzero(vowel_mask)[np.argmax(curve[vowel_mask])]) if valid else None
        word_results.append({"index": i, "text": w["label"], "start_sec": a, "end_sec": b,
            "relative_prominence": float(max(0, curve[peak])) if valid else None,
            "peak_sec": float(t[peak]) if valid else None,
            "components_at_peak": dict(zip(("pitch", "energy", "duration"),
                [float(x) for x in np.mean(components[:, :, peak], axis=1)])) if valid else None,
            "status": "uncertain" if reasons else "estimated", "reasons": reasons,
            "f0_coverage": coverage,
            "median_voiced_f0_hz": float(np.median(f0[mask & voiced])) if np.any(mask & voiced) else None,
            "mean_energy_dbfs": float(np.mean(energy[mask])) if np.any(mask) else None,
            "vowel_duration_ms": [round((p["end_sec"]-p["start_sec"])*1000, 3) for p in nuclei
                                  if p["start_sec"] >= a-.001 and p["end_sec"] <= b+.001],
            # Alignment gap is NOT a measured acoustic silence or detected boundary.
            "alignment_gap_after_ms": max(0., (words[i+1]["start_sec"]-b)*1000) if i+1<len(words) else None})
    return {"version": VERSION, "status": "exploratory", "calibrated": False,
        "duration_sec": duration, "weights": weights.tolist(), "scales_sec": SCALES_SEC.tolist(),
        "words": word_results, "vad_pauses": measurements.get("pauses", []),
        "nucleus_spacing_ms": (np.diff(centers)*1000).tolist(),
        "curves": {"time_sec": t.tolist(), "normalized_features": features.tolist(),
                   "pitch_support": pitch_support.tolist(), "cwt": scalogram.tolist(), "combined": curve.tolist()},
        "limitations": ["not_lexical_stress_or_correctness", "no_human_gold", "low_pitch_accents_may_be_missed",
                        "vowel_identity_and_phrase_final_duration_not_normalized", "not_toolkit_LOMA"]}


def cached_reference(sample: dict, directory: Path, *, identity: dict) -> tuple[dict, bool]:
    """Experiment-only cache; identity must include the exact reference/owner.

    Callers must validate availability/expiry before reuse. Include complete
    input bytes, algorithm, dependency and parameter versions in the key.
    """
    key = sha256(json.dumps({"identity": identity, "version": VERSION,
        "implementation": sha256(Path(__file__).read_bytes()).hexdigest(),
        "pywt": pywt.__version__, "numpy": np.__version__, "sample": sample},
        sort_keys=True, allow_nan=False).encode()).hexdigest()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / f"{key}.json"
    if path.exists():
        return json.loads(path.read_text()), True
    result = analyze(sample)
    with path.open("x") as stream:
        path.chmod(0o600)
        json.dump(result, stream, allow_nan=False)
    return result, False
