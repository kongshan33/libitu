"""Shared Reference/learner signal analysis. No ASR, MFA or browser features.

Continuous prominence only. Boundary jitter is a sensitivity diagnostic, not
validated confidence. Missing duration in a preview never means weak stress.
"""
from app.schemas.signal_prosody import SignalProsody, ProminenceWord, WordBoundary

VOWELS = frozenset("AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW".split())


def analyze_signal(measurements, boundaries: list[WordBoundary], source: str, *, origin: float = 0,
                   alignment=None) -> SignalProsody:
    import numpy as np
    import pywt

    result = SignalProsody(boundary_source=source, duration_sec=measurements.duration_sec)
    if any(x in measurements.quality_issues for x in ("clipping", "low_energy", "insufficient_speech")):
        result.reasons = list(measurements.quality_issues)
        return result
    frames = measurements.frames
    times = np.round([f.time_sec-origin for f in frames], 6)
    if len(times) < 5 or not np.all(np.isfinite(times)) or not np.allclose(np.diff(times), .01, atol=1e-5) \
            or times[0] < -.001 or times[0] >= .01+.001:
        result.reasons = ["frame_timing_unavailable"]
        return result
    speech = np.zeros(len(times), dtype=bool)
    for interval in measurements.speech:
        speech |= (times >= round(interval.start_sec-origin, 6)) & (times < round(interval.end_sec-origin, 6))
    if np.count_nonzero(speech) < 5:
        result.reasons = ["insufficient_speech"]
        return result
    energy = np.array([f.energy_dbfs for f in frames])
    f0 = np.array([f.f0_hz or np.nan for f in frames])
    if not np.all(np.isfinite(energy)):
        result.reasons = ["invalid_energy"]
        return result
    voiced = np.isfinite(f0) & speech
    raw_pitch = np.full(len(times), np.nan)
    pitch = np.zeros(len(times))

    def normalize(values, floor):
        return np.clip((values-np.median(values))/max(float(np.std(values)), floor), -4, 4)

    if np.count_nonzero(voiced) >= 5:
        raw_pitch[voiced] = 12*np.log2(f0[voiced]/np.median(f0[voiced]))
        indices = np.flatnonzero(voiced)
        pitch[voiced] = normalize(raw_pitch[voiced], 2.)
        for left, right in zip(indices, indices[1:]):
            if times[right]-times[left] <= .150001 and np.all(speech[left:right+1]):
                pitch[left:right+1] = np.linspace(pitch[left], pitch[right], right-left+1)
    else:
        result.reasons.append("insufficient_pitch")
    intensity = np.zeros(len(times))
    intensity[speech] = normalize(energy[speech], 3.)
    features, weights = [pitch, intensity], [.5, .5]
    if alignment is not None and alignment.status == "aligned":
        vowels = [p for p in alignment.phones if (p.label or "").rstrip("012") in VOWELS]
        if len(vowels) >= 3:
            centers = [(p.start_sec+p.end_sec)/2-origin for p in vowels]
            lengths = np.log([p.end_sec-p.start_sec for p in vowels])
            timing = np.interp(times, centers, normalize(lengths, .25))
            timing[~speech] = 0
            features.append(timing)
            weights = [.4, .4, .2]
            result.duration_evaluated = True
    if not result.duration_evaluated:
        result.reasons.append("duration_not_evaluated")
    scales = np.geomspace(.06, .24, 13)/.01
    pad = int(np.ceil(scales[-1]*8))
    curve = np.zeros(len(times))
    for feature, weight in zip(features, weights):
        matrix, _ = pywt.cwt(np.pad(feature, pad, mode="reflect"), scales, "mexh", sampling_period=.01, method="fft")
        curve += weight*np.mean(matrix[:, pad:-pad]/np.sqrt(scales[:, None]), axis=0)
    positive = np.maximum(curve, 0)
    # Every boundary source uses the identical time-window aggregation.
    def value(start, end):
        mask = (times >= round(start, 6)) & (times < round(end, 6)) & speech
        return float(np.percentile(positive[mask], 90)) if np.count_nonzero(mask) >= 3 else None

    previous = 0.
    for boundary in boundaries:
        a, b = boundary.start_sec, boundary.end_sec
        if b <= a or a < previous-.001 or b > result.duration_sec+.02:
            result.words = []
            result.reasons.append("boundary_timing_unavailable")
            break
        previous = b
        mask = (times >= round(a, 6)) & (times < round(b, 6)) & speech
        score = value(a,b)
        variants = [value(max(0,a+da), min(result.duration_sec,b+db))
                    for da in (-.05,0,.05) for db in (-.05,0,.05) if a+da < b+db]
        variants = [v for v in variants if v is not None]
        reasons = []
        if score is None:
            reasons.append("insufficient_frames")
        if np.count_nonzero(mask & voiced) < 5 or (np.any(mask) and np.mean(voiced[mask]) < .2):
            reasons.append("low_pitch_coverage")
        if a < .34 or result.duration_sec-b < .34:
            reasons.append("wavelet_edge")
        if variants and max(variants)-min(variants) > max(.1, .3*(score or 0)):
            reasons.append("boundary_sensitive")
        result.words.append(ProminenceWord(**boundary.model_dump(), value=score,
            sensitivity_range=[min(variants),max(variants)] if variants else [], uncertain=bool(reasons), reasons=reasons))
    if not boundaries:
        result.reasons.append("word_boundaries_unavailable")
    # Average into display bins; do not bridge missing pitch in the UI.
    for i in range(0,len(times),5):
        window = raw_pitch[i:i+5]
        result.pitch_st.append(float(np.median(window[np.isfinite(window)])) if np.count_nonzero(np.isfinite(window))>=2 else None)
        result.prominence.append(float(np.mean(positive[i:i+5])) if np.any(speech[i:i+5]) else None)
    return result


def subtitle_boundaries(sentence: dict) -> list[WordBoundary]:
    from app.services.acoustics.word_check import checked_tokens
    raw = sentence.get("word_timings") or []
    expected = [t.normalized for t in checked_tokens(sentence["text"])]
    actual = [t.normalized for w in raw for t in checked_tokens(w["text"])]
    if actual != expected or len(raw) != len(expected) or any(w.get("end_ms") is None for w in raw):
        return []
    return [WordBoundary(text=t, start_sec=(w["start_ms"]-sentence["start_ms"])/1000,
        end_sec=(w["end_ms"]-sentence["start_ms"])/1000, source_index=i) for i,(w,t) in enumerate(zip(raw,expected))]


def learner_boundaries(check) -> list[WordBoundary]:
    mapping = {op.recognized_index:op.source_index for op in check.operations if op.kind == "matched"}
    return [w.model_copy(update={"source_index":mapping.get(i)}) for i,w in enumerate(check.word_timings)]


def mfa_boundaries(alignment, *, origin=0., mapping=None) -> list[WordBoundary]:
    return [WordBoundary(text=w.label or "", start_sec=max(0,w.start_sec-origin), end_sec=w.end_sec-origin,
        source_index=i if mapping is None else mapping.get(i)) for i,w in enumerate(alignment.words)]
