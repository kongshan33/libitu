from app.schemas.practice_analysis import AlignedPhone, ContentCheck, ProsodyResult, VoiceProsody, WordProsody
from app.services.acoustics.comparison import assess_checked
from app.services.acoustics.word_check import analysis_scope, check_words, content_check


def compared(actual):
    source = 'one two three four five six seven eight nine ten'
    check = check_words(source, {'text': actual, 'reliable': True})
    def word(text, i, source_index=None):
        return WordProsody(text=text, start_sec=i*.3, end_sec=(i+1)*.3, duration_ms=300,
            phones=[AlignedPhone(label='AH0', duration_ms=100), AlignedPhone(label='T', duration_ms=200)],
            boundary_pause_ms=0, pitch_curve_st=[0]*5, recognized_index=i, source_index=source_index)
    reference = VoiceProsody(content=ContentCheck(status='matched'), alignment_status='aligned',
        words=[word(t.normalized, i) for i, t in enumerate(check.source_tokens)])
    mapping = {op.recognized_index: op.source_index for op in check.operations if op.kind == 'matched'}
    learner = VoiceProsody(content=content_check(check), alignment_status='aligned',
        words=[word(t.normalized, i, mapping.get(i)) for i, t in enumerate(check.recognized_tokens)])
    result = ProsodyResult(learner=learner, reference=reference, comparison='available')
    return check, result


def test_partial_sound_scores_only_exact_words_on_source_axis():
    check, result = compared('one two xx four five six xx eight xx xx')
    assert check.tier == 'partial_60_85'
    assessment = assess_checked(result, check, analysis_scope(check))
    vowel = next(c for c in assessment.sound if c.kind == 'vowel_length')
    linking = next(c for c in assessment.sound if c.kind == 'linking')
    assert [p.word_index for p in vowel.pairs] == [0, 1, 3, 4, 5, 7]
    assert [p.word_index for p in linking.pairs] == [0, 3, 4]
    assert assessment.rhythm.value is assessment.melody.value is None
    assert assessment.rhythm.reason == assessment.melody.reason == 'match_threshold_not_met'


def test_inserted_word_breaks_sound_and_rhythm_boundary():
    check, result = compared('one two um three four five six seven eight nine ten')
    assert check.tier == 'full_85_plus'
    assessment = assess_checked(result, check, 'all_layers')
    linking = next(c for c in assessment.sound if c.kind == 'linking')
    assert 1 not in [p.word_index for p in linking.pairs]
    assert len(linking.pairs) == 8
    assert assessment.rhythm.compared == 18  # ten durations plus eight reliable boundaries
    assert assessment.melody.compared == 50  # extra word is not compared as a source word


def test_high_match_with_omission_keeps_gaps_and_does_not_compare_wrong_word():
    check, result = compared('one two three four six seven eight nine ten')
    assert check.matched_count == 9 and check.tier == 'full_85_plus'
    assessment = assess_checked(result, check, 'all_layers')
    vowel = next(c for c in assessment.sound if c.kind == 'vowel_length')
    linking = next(c for c in assessment.sound if c.kind == 'linking')
    assert 4 not in [p.word_index for p in vowel.pairs]
    assert not {3, 4}.intersection(p.word_index for p in linking.pairs)
    assert assessment.rhythm.compared == 16
    assert assessment.melody.compared == 45


def test_uncertain_reference_and_bad_quality_withhold_comparison():
    check, result = compared('one two three four five six seven eight nine ten')
    result.reference.content.status = 'uncertain'
    assessment = assess_checked(result, check, 'all_layers')
    assert all(not item.pairs for item in assessment.sound)
    assert assessment.rhythm.value is assessment.melody.value is None
    result.reference.content.status = 'matched'
    result.learner.quality_issues = ['clipping']
    assert all(not item.pairs for item in assess_checked(result, check, 'all_layers').sound)


def test_source_transcript_reference_supports_all_layers_without_asr_claim():
    check, result = compared('one two three four five six seven eight nine ten')
    result.reference.content = ContentCheck(status='source_transcript', reason='source_transcript_not_asr_verified')
    assessment = assess_checked(result, check, 'all_layers')
    assert any(item.pairs for item in assessment.sound)
    assert assessment.rhythm.value is not None and assessment.melody.value is not None
    assert result.reference.content.status != 'matched' and result.reference.content.transcript == ''
    result.reference.alignment_status = 'unavailable'
    assessment = assess_checked(result, check, 'all_layers')
    assert not any(item.pairs for item in assessment.sound)
    assert assessment.rhythm.value is assessment.melody.value is None
