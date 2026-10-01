"""Experimental reference resemblance, never phonological correctness/confidence.

Only measured pairs enter a score. Unknown/unsupported targets are not zeros or
perfect matches. Algorithm scales are engineering defaults, not human calibration.
"""
import math
from statistics import mean, median

from app.integrations.cmudict_lexicon import CONSONANTS, VOWELS
from app.schemas.practice_analysis import LayerAssessment, ProsodyResult, SimilarityScore, SoundCheck, SoundMeasurementPair
from app.services.acoustics.engine import tokens

UNSUPPORTED = {
    "weak_form": "Vowel identity/reduction needs independent phone evidence; short duration alone cannot establish a weak form.",
    "flap": "A short aligned /t/ or /d/ does not establish a tap. A validated realization detector is still required.",
    "elision": "Forced alignment cannot establish deletion; unreleased stops must be distinguished from absent stops.",
    "assimilation": "Requires an independently validated phone-change detector.",
    "glottal": "Pitch gaps do not establish a glottal stop; a validated detector is still required.",
    "drop_d": "Drop-D is an elision subtype and requires independent evidence of deletion.",
    "h_drop": "Low energy alone does not establish H-dropping; a validated detector is still required.",
    "voicing": "Missing F0 alone does not establish consonant devoicing; a validated detector is still required.",
}


def score(values: list[float], eligible: int, minimum: int = 1) -> SimilarityScore:
    enough = len(values) >= minimum and eligible > 0 and len(values) / eligible >= .6
    return SimilarityScore(value=round(mean(values), 1) if enough else None, compared=len(values), eligible=eligible,
        reason=None if enough else "insufficient_coverage" if eligible else "no_targets")


def resemblance(a: float, b: float) -> float:
    return 100 * min(a, b) / max(a, b) if a > 0 and b > 0 else 0


def assess(result: ProsodyResult, text: str) -> LayerAssessment:
    checks = [SoundCheck(kind=kind, status="unsupported", note=note, score=SimilarityScore(reason="detector_not_validated"))
              for kind, note in UNSUPPORTED.items()]
    vowel = SoundCheck(kind="vowel_length", status="insufficient_evidence",
        note="Vowel timing resemblance, adjusted for overall pace. This does not judge vowel identity or correctness.")
    linking = SoundCheck(kind="linking", status="insufficient_evidence",
        note="Detected pause timing at possible consonant–vowel boundaries. No detected pause does not prove linking.")
    output = LayerAssessment(sound=[linking, *checks, vowel])
    a, b = result.reference, result.learner
    if result.comparison != "available" or not a or any(v.content.status != "matched" or v.alignment_status != "aligned"
            or any(q in v.quality_issues for q in ("insufficient_speech", "low_energy", "clipping")) for v in (a,b)) \
            or not a.words or [w.text for w in a.words] != [w.text for w in b.words] \
            or [t for w in a.words for t in tokens(w.text)] != tokens(text):
        for item in (vowel, linking):
            item.score.reason = "paired_audio_unavailable"
        output.rhythm.reason = output.melody.reason = "paired_audio_unavailable"
        return output
    valid = all(25 <= w.duration_ms <= 3000 for voice in (a,b) for w in voice.words)
    if not valid or len(a.words) < 3:
        for item in (vowel, linking):
            item.score.reason = "insufficient_alignment"
        output.rhythm.reason = output.melody.reason = "insufficient_alignment"
        return output
    pace = median(y.duration_ms / r.duration_ms for r,y in zip(a.words,b.words))
    vowel_targets = 0
    for i,(r,y) in enumerate(zip(a.words,b.words)):
        if not r.phones:
            # Missing phone evidence is an unknown target, not absence of vowels.
            vowel_targets += 1
            continue
        rp = [p for p in r.phones if p.label.rstrip("012") in VOWELS]
        yp = [p for p in y.phones if p.label.rstrip("012") in VOWELS]
        if not rp:
            continue
        vowel_targets += 1
        if [p.label.rstrip("012") for p in rp] != [p.label.rstrip("012") for p in yp] \
            or any(not 25 <= p.duration_ms <= 800 for p in rp+yp):
            continue
        rv, yv = sum(p.duration_ms for p in rp), sum(p.duration_ms for p in yp)
        vowel.pairs.append(SoundMeasurementPair(word_index=i, end_index=i+1, reference=round(rv,1), learner=round(yv,1),
            similarity=round(resemblance(rv,yv/pace),1)))
    vowel.score = score([p.similarity for p in vowel.pairs], vowel_targets)
    vowel.status = "measured" if vowel.pairs else "no_targets" if not vowel_targets else "insufficient_evidence"
    # Dictionary-constrained phone labels select candidate contexts only. The
    # measurement remains VAD boundary timing, never proof of a realized link.
    targets = [i for i,(left,right) in enumerate(zip(a.words,a.words[1:])) if left.phones and right.phones
        and left.phones[-1].label.rstrip("012") in CONSONANTS and right.phones[0].label.rstrip("012") in VOWELS]
    missing_contexts = sum(not left.phones or not right.phones for left,right in zip(a.words,a.words[1:]))
    for i in targets:
        r, y = a.words[i].boundary_pause_ms, b.words[i].boundary_pause_ms
        if r is not None and y is not None:
            linking.pairs.append(SoundMeasurementPair(word_index=i, end_index=i+2, reference=r, learner=y,
                similarity=round(100*math.exp(-abs(r-y)/200),1)))
    linking.score = score([p.similarity for p in linking.pairs], len(targets)+missing_contexts)
    linking.status = "measured" if linking.pairs else "no_targets" if not targets and not missing_contexts else "insufficient_evidence"
    rhythm = [resemblance(r.duration_ms,y.duration_ms/pace) for r,y in zip(a.words,b.words)]
    rhythm += [100*math.exp(-abs(r.boundary_pause_ms-y.boundary_pause_ms)/200)
        for r,y in zip(a.words[:-1],b.words[:-1]) if r.boundary_pause_ms is not None and y.boundary_pause_ms is not None]
    output.rhythm = score(rhythm, len(a.words)*2-1, minimum=3)
    pitch_scores, possible, common_words = [], 0, 0
    for r,y in zip(a.words,b.words):
        rc, yc = r.pitch_curve_st, y.pitch_curve_st
        if len(rc)!=5 or len(yc)!=5:
            possible += 5
            continue
        possible += sum(x is not None or z is not None for x,z in zip(rc,yc))
        pairs = [(x,z) for x,z in zip(rc,yc) if x is not None and z is not None]
        if len(pairs)>=3:
            common_words += 1
        pitch_scores.extend(100*math.exp(-abs(x-z)/3) for x,z in pairs)
    output.melody = score(pitch_scores, max(possible, 3*len(a.words)), minimum=9)
    if common_words < 3 or any("insufficient_pitch" in v.quality_issues for v in (a,b)):
        output.melody.value, output.melody.reason = None, "insufficient_pitch"
    return output
