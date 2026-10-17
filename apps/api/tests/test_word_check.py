import pytest

from app.services.acoustics.word_check import analysis_scope, check_words, checked_tokens


@pytest.mark.parametrize('matched,total,tier,scope', [
    (2, 5, 'below_60', 'none'), (3, 5, 'partial_60_85', 'sound_only'),
    (16, 20, 'partial_60_85', 'sound_only'), (17, 20, 'full_85_plus', 'all_layers'),
    (20, 20, 'full_85_plus', 'all_layers'),
    (119, 199, 'below_60', 'none'), (169, 199, 'partial_60_85', 'sound_only'),
])
def test_exact_thresholds_and_display_rounding_cannot_unlock(matched, total, tier, scope):
    source = ' '.join(f'w{i}' for i in range(total))
    actual = ' '.join(f'w{i}' if i < matched else f'x{i}' for i in range(total))
    check = check_words(source, {'text': actual, 'reliable': True})
    assert (check.matched_count, check.source_count, check.tier) == (matched, total, tier)
    assert analysis_scope(check) == scope


def test_repeated_words_have_deterministic_position_identity():
    check = check_words('go go now', {'text': 'go now', 'reliable': True})
    assert [(op.kind, op.source_index, op.recognized_index) for op in check.operations] == [
        ('omitted', 0, None), ('matched', 1, 0), ('matched', 2, 1)]


def test_substitutions_and_insertions_retain_source_boundaries():
    check = check_words('We are ready', {'text': 'um we were ready today', 'reliable': True})
    assert [(op.kind, op.source_index, op.recognized_index, op.source_boundary) for op in check.operations] == [
        ('inserted', None, 0, 0), ('matched', 0, 1, None), ('substituted', 1, 2, None),
        ('matched', 2, 3, None), ('inserted', None, 4, 3)]
    assert (check.matched_count, check.source_count, check.tier) == (2, 3, 'partial_60_85')


def test_nfkc_contractions_hyphens_and_original_offsets():
    text = 'Ｗｅ don’t re-enter ﬃ, 42!'
    tokens = checked_tokens(text)
    assert [t.normalized for t in tokens] == ['we', "don't", 're', 'enter', 'ffi', '42']
    assert all(text[t.start:t.end] == t.display for t in tokens)
    assert len(checked_tokens("don't")) == 1
    assert checked_tokens('e\u0301') == []  # NFKC composes the accent, rather than recognizing a stray e.


def test_no_synonym_contraction_or_number_rewriting():
    check = check_words("we are ready 2", {'text': "we're prepared two", 'reliable': True})
    assert check.matched_count == 0


@pytest.mark.parametrize('text,actual,reliable,status,reason', [
    ('ready', '', True, 'uncertain', 'recognition_uncertain'),
    ('ready', 'ready', False, 'uncertain', 'recognition_uncertain'),
    ('!!!', 'ready', True, 'unavailable', 'source_words_unavailable'),
    (' '.join(['word'] * 1025), 'word', True, 'unavailable', 'word_check_limit_exceeded'),
])
def test_unreliable_or_unbounded_checks_never_publish_a_zero_tier(text, actual, reliable, status, reason):
    check = check_words(text, {'text': actual, 'reliable': reliable})
    assert (check.status, check.reason, check.tier, check.operations) == (status, reason, None, [])
    assert analysis_scope(check) == 'none'


def test_persisted_check_cannot_inflate_tier_or_change_operation_positions():
    from pydantic import ValidationError
    from app.schemas.practice_analysis import WordCheck
    check = check_words('one two three four five', {'text': 'one two three xx yy', 'reliable': True}).model_dump()
    check['tier'] = 'full_85_plus'
    with pytest.raises(ValidationError, match='counts or tier'):
        WordCheck.model_validate(check)
    check['tier'] = 'partial_60_85'
    check['operations'][0]['source_index'] = 1
    with pytest.raises(ValidationError, match='source position'):
        WordCheck.model_validate(check)
