from copy import deepcopy

import pytest

from app.schemas.practice_analysis import AlignedPhone, ContentCheck, ProsodyResult, VoiceProsody, WordProsody
from app.schemas.reference import Alignment, Frame, Interval, Measurements
from app.services.acoustics.comparison import assess
from app.services.acoustics.practice_prosody import word_measurements


def voices():
    words = [WordProsody(text=text, start_sec=i*.4, end_sec=i*.4+.3, duration_ms=300,
        boundary_pause_ms=0 if i<2 else None, pitch_st=0, pitch_curve_st=[-2,-1,0,1,2],
        phones=[AlignedPhone(label=label, duration_ms=180)]) for i,(text,label) in enumerate(zip(['make','it','again'],['EY1','IH1','EH1']))]
    words[0].phones.append(AlignedPhone(label='K',duration_ms=60))
    words[1].phones.append(AlignedPhone(label='T',duration_ms=60))
    v = VoiceProsody(content=ContentCheck(status='matched'), alignment_status='aligned', words=words)
    return ProsodyResult(learner=v, reference=deepcopy(v), comparison='available')


def check(result, kind):
    return next(c for c in result.sound if c.kind==kind)


def test_identical_supported_measurements_but_no_fabricated_realization_scores():
    result = assess(voices(), 'Make it again.')
    assert result.rhythm.value == result.melody.value == 100
    assert check(result,'vowel_length').score.value == 100
    assert check(result,'linking').score.value == 100
    for item in result.sound:
        assert item.realization == 'not_evaluated'
        if item.kind not in ('vowel_length','linking'):
            assert item.status == 'unsupported' and item.score.value is None


def test_uniform_pace_change_does_not_penalize_vowel_or_word_timing():
    v = voices()
    for word in v.learner.words:
        word.duration_ms *= 1.5
        word.phones[0].duration_ms *= 1.5
    result = assess(v, 'Make it again.')
    assert check(result,'vowel_length').score.value == result.rhythm.value == 100


def test_local_duration_pitch_and_pause_differences_affect_only_measured_pairs():
    v = voices()
    v.learner.words[0].phones[0].duration_ms *= 2
    v.learner.words[0].boundary_pause_ms = 400
    for word in v.learner.words:
        word.pitch_curve_st = [x+3 for x in word.pitch_curve_st]
    result = assess(v, 'Make it again.')
    assert 0 < check(result,'vowel_length').score.value < 100
    assert 0 < check(result,'linking').score.value < 100
    assert 0 < result.rhythm.value < 100
    assert result.melody.value == pytest.approx(36.8)


def test_missing_pitch_and_phone_identity_disagreement_abstain_instead_of_scoring_zero():
    v = voices()
    for word in v.learner.words:
        word.pitch_curve_st = [None]*5
        word.phones[0].label = 'AA1'
    result = assess(v, 'Make it again.')
    assert result.melody.value is None
    assert check(result,'vowel_length').score.value is None
    assert check(result,'vowel_length').score.compared == 0
    assert check(result,'vowel_length').score.eligible == 3


@pytest.mark.parametrize('change', ['no_reference','mismatch','bad_alignment','different_words','bad_quality','wrong_text','short_word'])
def test_all_pair_scores_require_independent_audio_identity_and_quality(change):
    v = voices()
    if change=='no_reference': v.reference=None
    if change=='mismatch': v.learner.content.status='mismatch'
    if change=='bad_alignment': v.reference.alignment_status='failed'
    if change=='different_words': v.learner.words[0].text='take'
    if change=='short_word': v.learner.words[0].duration_ms=1
    if change=='bad_quality': v.learner.quality_issues=['clipping']
    result = assess(v, 'Take it again.' if change=='wrong_text' else 'Make it again.')
    assert result.rhythm.value is None and result.melody.value is None
    assert all(c.score.value is None and not c.pairs for c in result.sound)


def test_no_targets_and_unknown_boundaries_cannot_earn_perfect_scores():
    v = voices()
    for word in v.learner.words: word.boundary_pause_ms=None
    result = assess(v, 'Make it again.')
    assert check(result,'linking').score.value is None
    assert check(result,'linking').score.eligible > 0
    for voice in (v.learner,v.reference):
        for word in voice.words: word.phones=[]
    result = assess(v,'Make it again.')
    assert check(result,'vowel_length').score.value is None
    assert check(result,'vowel_length').status == 'insufficient_evidence'
    for voice in (v.learner,v.reference):
        for word in voice.words: word.phones=[AlignedPhone(label='M',duration_ms=300)]
    assert check(assess(v,'Make it again.'),'vowel_length').status == 'no_targets'


def test_measurements_map_actual_phones_and_distinguish_unknown_from_no_pause():
    aligned = Alignment(status='aligned', words=[Interval(start_sec=0,end_sec=.3,label='we'),Interval(start_sec=.3,end_sec=.6,label='go')],
        phones=[Interval(start_sec=0,end_sec=.1,label='W'),Interval(start_sec=.1,end_sec=.3,label='IY1'),
            Interval(start_sec=.3,end_sec=.4,label='G'),Interval(start_sec=.4,end_sec=.6,label='OW1')])
    measured = Measurements(duration_sec=.6,rms_dbfs=-20,clipping_fraction=0,f0_valid_fraction=1,
        frames=[Frame(time_sec=i*.01,f0_hz=100,energy_dbfs=-20) for i in range(60)],speech=[Interval(start_sec=0,end_sec=.6)],pauses=[],quality_issues=[])
    words = word_measurements(aligned,measured)
    assert words[0].phones[1].duration_ms == 200 and words[0].boundary_pause_ms == 0
    assert words[1].boundary_pause_ms is None
    measured.speech=[]
    assert word_measurements(aligned,measured)[0].boundary_pause_ms is None
    aligned.phones[1].end_sec=.2
    assert word_measurements(aligned,measured)[0].phones == []
