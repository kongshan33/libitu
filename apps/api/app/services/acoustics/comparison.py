"""Experimental reference resemblance, never phonological correctness/confidence.

Only measured pairs enter a score. Unknown/unsupported targets are not zeros or
perfect matches. Algorithm scales are engineering defaults, not human calibration.
"""
import math
from statistics import mean, median

from app.integrations.cmudict_lexicon import CONSONANTS, VOWELS
from app.schemas.practice_analysis import AnalysisScope, LayerAssessment, ProsodyResult, SimilarityScore, SoundCheck, SoundMeasurementPair, WordCheck
from app.services.acoustics.engine import tokens
from app.services.acoustics.word_check import checked_tokens
from app.services.acoustics.reference_prosody import reference_content_available

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
    if result.comparison != "available" or not a or not reference_content_available(a) or b.content.status != "matched" \
            or any(v.alignment_status != "aligned"
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


def assess_checked(result: ProsodyResult, check: WordCheck, scope: AnalysisScope) -> LayerAssessment:
    """Compare only mapped exact words; missing positions never become zero scores."""
    output = assess(ProsodyResult(learner=result.learner), "")
    vowel = next(item for item in output.sound if item.kind == "vowel_length")
    linking = next(item for item in output.sound if item.kind == "linking")
    if scope == "sound_only":
        output.rhythm.reason = output.melody.reason = "match_threshold_not_met"
    ref, learner = result.reference, result.learner
    if result.comparison != "available" or not ref or learner.alignment_status != "aligned" or ref.alignment_status != "aligned" \
            or not reference_content_available(ref) or any(q in voice.quality_issues
                for voice in (ref, learner) for q in ("insufficient_speech", "low_energy", "clipping")) \
            or len(ref.words) != check.source_count or [t.normalized for w in ref.words for t in checked_tokens(w.text)] \
                != [t.normalized for t in check.source_tokens]:
        return output
    expected = {op.recognized_index: op.source_index for op in check.operations if op.kind == "matched"}
    mapped = {w.source_index: w for w in learner.words if w.source_index is not None
              and w.recognized_index in expected and expected[w.recognized_index] == w.source_index
              and [t.normalized for t in checked_tokens(w.text)] == [check.source_tokens[w.source_index].normalized]
              and 25 <= w.duration_ms <= 3000 and 25 <= ref.words[w.source_index].duration_ms <= 3000}
    if len(mapped) < 3:
        vowel.score.reason = linking.score.reason = "insufficient_alignment"
        if scope == "all_layers":
            output.rhythm.reason = output.melody.reason = "insufficient_alignment"
        return output
    pace = median(w.duration_ms / ref.words[i].duration_ms for i, w in mapped.items())
    vowel_targets = 0
    for i, yours in sorted(mapped.items()):
        reference = ref.words[i]
        if not reference.phones:
            vowel_targets += 1
            continue
        rp = [p for p in reference.phones if p.label.rstrip("012") in VOWELS]
        yp = [p for p in yours.phones if p.label.rstrip("012") in VOWELS]
        if not rp:
            continue
        vowel_targets += 1
        if [p.label.rstrip("012") for p in rp] != [p.label.rstrip("012") for p in yp] \
                or any(not 25 <= p.duration_ms <= 800 for p in rp + yp):
            continue
        rv, yv = sum(p.duration_ms for p in rp), sum(p.duration_ms for p in yp)
        vowel.pairs.append(SoundMeasurementPair(word_index=i, end_index=i+1, reference=round(rv, 1), learner=round(yv, 1),
                                                similarity=round(resemblance(rv, yv / pace), 1)))
    vowel.score = score([p.similarity for p in vowel.pairs], vowel_targets)
    vowel.status = "measured" if vowel.pairs else "no_targets" if not vowel_targets else "insufficient_evidence"
    # Both source and recognized positions must be adjacent. Insertions break links.
    boundaries = [i for i in sorted(mapped) if i+1 in mapped
                  and mapped[i].recognized_index + 1 == mapped[i+1].recognized_index]
    targets, missing = [], 0
    for i in boundaries:
        left, right = ref.words[i:i+2]
        if not left.phones or not right.phones:
            missing += 1
        elif left.phones[-1].label.rstrip("012") in CONSONANTS and right.phones[0].label.rstrip("012") in VOWELS:
            targets.append(i)
    for i in targets:
        r, y = ref.words[i].boundary_pause_ms, mapped[i].boundary_pause_ms
        if r is not None and y is not None:
            linking.pairs.append(SoundMeasurementPair(word_index=i, end_index=i+2, reference=r, learner=y,
                                                      similarity=round(100*math.exp(-abs(r-y)/200), 1)))
    linking.score = score([p.similarity for p in linking.pairs], len(targets) + missing)
    linking.status = "measured" if linking.pairs else "no_targets" if not targets and not missing else "insufficient_evidence"
    if scope != "all_layers":
        return output
    rhythm = [resemblance(ref.words[i].duration_ms, w.duration_ms / pace) for i, w in mapped.items()]
    rhythm += [100*math.exp(-abs(ref.words[i].boundary_pause_ms-mapped[i].boundary_pause_ms)/200)
               for i in boundaries if ref.words[i].boundary_pause_ms is not None and mapped[i].boundary_pause_ms is not None]
    output.rhythm = score(rhythm, check.source_count*2-1, minimum=3)
    pitch_scores, common_words = [], 0
    for i, w in mapped.items():
        rc, yc = ref.words[i].pitch_curve_st, w.pitch_curve_st
        pairs = [(r, y) for r, y in zip(rc, yc) if r is not None and y is not None] if len(rc) == len(yc) == 5 else []
        common_words += len(pairs) >= 3
        pitch_scores.extend(100*math.exp(-abs(r-y)/3) for r, y in pairs)
    output.melody = score(pitch_scores, check.source_count*5, minimum=9)
    if common_words < 3 or any("insufficient_pitch" in v.quality_issues for v in (ref, learner)):
        output.melody.value, output.melody.reason = None, "insufficient_pitch"
    return output
