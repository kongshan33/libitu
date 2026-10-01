import hashlib
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.integrations import cmudict_lexicon
from app.main import app
from app.schemas.blueprint import Blueprint, HighlightedTranscriptPart, TranscriptLine
from app.services import sound_service, store
from app.services.sound_service import annotate_sentence


client = TestClient(app)


def annotate(text: str):
    return annotate_sentence("sound-fixture", "sound-sentence", text)


def of_kind(text: str, kind: str):
    return [item for item in annotate(text).candidates if item.kind == kind]


@pytest.fixture(autouse=True)
def clear_sound_cache():
    sound_service._cache.clear()
    yield
    sound_service._cache.clear()


def test_full_pinned_dictionary_loads_without_package_or_model():
    lexicon = cmudict_lexicon.get_pronunciation_lexicon()
    assert len(lexicon.words) == 126_052
    assert lexicon.version == "cmudict-74790861f652"
    assert hashlib.sha256(cmudict_lexicon.LEXICON_PATH.read_bytes()).hexdigest() == cmudict_lexicon.LEXICON_SHA256
    assert lexicon.words["better"] == (("B", "EH1", "T", "ER0"),)
    assert len(lexicon.words["read"]) == 2
    assert lexicon is cmudict_lexicon.get_pronunciation_lexicon()


@pytest.mark.parametrize("text,source", [("Red apple.", "Red apple"), ("Pick up.", "Pick up"), ("Red\tapple.", "Red\tapple")])
def test_linking_requires_consonant_vowel_boundary(text, source):
    candidates = of_kind(text, "linking")
    assert len(candidates) == 1
    assert candidates[0].source_text == source
    assert candidates[0].token_start == 0 and candidates[0].token_end == 2
    assert candidates[0].status == "candidate"
    assert "without a pause" in candidates[0].conditions[0]


@pytest.mark.parametrize("text", [
    "Red, apple.", "Red—apple.", "Red-apple.", "Red/apple.", "Red. Apple.",
    "Red (apple).", "Red 😀 apple.", "Red & apple.", "red_apple", "Blue apple.",
    "Red car.", "Read apple.", "Xqzt apple.", "Red 123 apple.", "Red R2D2 apple.",
])
def test_linking_abstains_at_punctuation_unknown_and_ambiguous_boundaries(text):
    assert of_kind(text, "linking") == []


@pytest.mark.parametrize("word", ["better", "ladder", "water", "pretty", "city"])
def test_flap_is_internal_primary_stress_to_unstressed_vowel(word):
    candidate, = of_kind(word, "flap")
    assert candidate.source_text == word and candidate.token_end == candidate.token_start + 1
    assert "ɾ" in candidate.phonemes_after
    assert "primary lexical stress" in candidate.conditions[0]


@pytest.mark.parametrize("text", ["attack", "retail", "boat", "carpet", "at ease", "read", "Xqzt"])
def test_flap_does_not_assume_all_intervocalic_or_cross_word_stops_are_taps(text):
    assert of_kind(text, "flap") == []


def test_flap_rejects_unstressed_preceding_vowel_in_dictionary():
    # "attack" has AH0 T AE1; "retail" has IY1 T EY2. Both are deliberately excluded.
    lexicon = cmudict_lexicon.get_pronunciation_lexicon()
    assert lexicon.words["attack"] == (("AH0", "T", "AE1", "K"),)
    assert lexicon.words["retail"] == (("R", "IY1", "T", "EY2", "L"),)
    assert not of_kind("attack retail", "flap")


@pytest.mark.parametrize("text,source,after", [
    ("We got you.", "got you", "[tʃ]"), ("We showed you.", "showed you", "[dʒ]"),
])
def test_coalescence_is_conditional_for_pronoun_y(text, source, after):
    candidate, = of_kind(text, "assimilation")
    assert candidate.source_text == source and candidate.phonemes_after == after
    assert "unstressed" in candidate.conditions[0]


@pytest.mark.parametrize("text", [
    "Got, you.", "Got your book.", "Did you?", "Red yacht.", "Got yogurt.", "Got young.",
])
def test_coalescence_skips_punctuation_non_pronouns_and_ambiguous_pronunciations(text):
    assert of_kind(text, "assimilation") == []


@pytest.mark.parametrize("text", ["Best boy.", "Cold milk.", "Left school."])
def test_elision_is_optional_final_cluster_simplification(text):
    candidate, = of_kind(text, "elision")
    assert "#" in candidate.phonemes_before
    assert "optional" in " ".join(candidate.conditions)
    assert "unreleased stop" in " ".join(candidate.conditions)


@pytest.mark.parametrize("text", ["Red boy.", "Best apple.", "Best, boy.", "Last week.", "Next week."])
def test_elision_requires_cluster_and_unambiguous_following_consonant(text):
    assert not of_kind(text, "elision")


@pytest.mark.parametrize("text,word,after", [
    ("We chose a plan.", "a", "/ə/"), ("We ate an apple.", "an", "/ən/"),
    ("Red and blue.", "and", "/ənd/"), ("Both of them.", "of", "/əv/"),
    ("We went to school.", "to", "/tə/"), ("We chose the plan.", "the", "/ðə/"),
    ("We chose the apple.", "the", "/ði/"),
])
def test_small_weak_form_whitelist_is_conditional_on_grammar_and_emphasis(text, word, after):
    candidate, = of_kind(text, "weak_form")
    assert candidate.source_text == word and candidate.phonemes_after == after
    assert "Used as" in candidate.conditions[0]
    assert "unstressed" in candidate.conditions[1]


@pytest.mark.parametrize("text", [
    "Can you?", "We can swim.", "A can fell.", "The plan.", "A plan.", "An apple.",
    "We chose A plan.", "We chose 'a' plan.", "We chose, a plan.", "We chose a, plan.",
    "We have to eat.", "We went to Xqzt.", "We chose the Xqzt.", "We chose a.",
])
def test_weak_forms_skip_can_edges_quoted_letters_and_unsupported_context(text):
    assert not of_kind(text, "weak_form")


def test_utf16_offsets_preserve_emoji_curly_contractions_hyphens_numbers_and_exact_spans():
    text = "😀 We can’t read twenty-one or 123 cats. Red\tapple; better."
    result = annotate(text)
    assert [token.text for token in result.tokens] == [
        "We", "can’t", "read", "twenty", "one", "or", "123", "cats", "Red", "apple", "better",
    ]
    assert result.tokens[0].start == 3
    assert result.tokens[1].pronunciations  # Curly apostrophe resolves the real can't entry.
    assert next(token for token in result.tokens if token.text == "read").status == "ambiguous"
    assert next(token for token in result.tokens if token.text == "123").status == "unknown"
    raw = text.encode("utf-16-le")
    for token in result.tokens:
        assert raw[token.start * 2:token.end * 2].decode("utf-16-le") == token.text
        assert len(token.ipa) == len(token.pronunciations) <= 4
    for candidate in result.candidates:
        start = result.tokens[candidate.token_start].start
        end = result.tokens[candidate.token_end - 1].end
        assert raw[start * 2:end * 2].decode("utf-16-le") == candidate.source_text
    assert result.coverage.total == len(result.tokens)
    assert result.coverage.known == sum(token.status == "known" for token in result.tokens)


@pytest.mark.parametrize("text", ["", "... 😀 —", "123 4th R2D2 café 中文"])
def test_no_guessed_ipa_for_empty_or_unsupported_tokens(text):
    result = annotate(text)
    assert result.candidates == []
    assert all(token.status == "unknown" and token.ipa == [] and token.pronunciations == [] for token in result.tokens)


def test_phone_rules_skip_every_ambiguous_variant_instead_of_picking_the_first():
    result = annotate("Read apple. Last week. Did you?")
    assert len(next(token for token in result.tokens if token.text == "Read").pronunciations) == 2
    assert not result.candidates
    assert any("ambiguous" in warning for warning in result.warnings)
    assert not {"confidence", "score", "observed"}.intersection(result.model_dump())


@pytest.mark.parametrize("acronym", ["SAT", "IT", "AI"])
def test_uppercase_acronyms_do_not_inherit_lowercase_word_pronunciations(acronym):
    text = f"😀 We took the {acronym} exam."
    result = annotate(text)
    token = next(token for token in result.tokens if token.text == acronym)
    assert token.status == "unknown" and token.pronunciations == [] and token.ipa == []
    assert not any(candidate.kind == "weak_form" for candidate in result.candidates)
    assert not any(candidate.token_start <= token.index < candidate.token_end for candidate in result.candidates)
    raw = text.encode("utf-16-le")
    assert raw[token.start * 2:token.end * 2].decode("utf-16-le") == acronym


def test_title_case_words_keep_dictionary_readings_but_uppercase_a_stays_unresolved():
    result = annotate("😀 I Sat up. A better plan.")
    tokens = {token.text: token for token in result.tokens}
    assert tokens["I"].status == "known" and tokens["I"].pronunciations == [["AY1"]]
    assert tokens["Sat"].status == "known" and tokens["Sat"].pronunciations == [["S", "AE1", "T"]]
    assert tokens["A"].status == "unknown" and not tokens["A"].pronunciations
    assert any(candidate.kind == "linking" and candidate.source_text == "Sat up" for candidate in result.candidates)
    assert any(candidate.kind == "flap" and candidate.source_text == "better" for candidate in result.candidates)
    raw = result.sentence_text.encode("utf-16-le")
    for token in result.tokens:
        assert raw[token.start * 2:token.end * 2].decode("utf-16-le") == token.text


def test_token_and_candidate_limits_report_truncation():
    result = annotate("better " * 301)
    assert result.sentence_text == "better " * 301
    assert len(result.tokens) == 300 and len(result.candidates) == 80
    assert any("300 tokens" in warning for warning in result.warnings)
    assert any("80 candidates" in warning for warning in result.warnings)
    assert all(candidate.token_end <= 300 for candidate in result.candidates)


@pytest.mark.parametrize("text", ["a" * 6001, "😀" * 3001])
def test_character_limit_rejects_without_truncating_sentence_identity(text):
    with pytest.raises(sound_service.SoundInputTooLong):
        annotate(text)


def test_cache_is_bounded_versioned_content_specific_and_does_not_expose_mutable_results(monkeypatch):
    monkeypatch.setattr(sound_service, "MAX_CACHE_ENTRIES", 2)
    first = annotate_sentence("cache-a", "same-sentence", "Red apple.")
    first.tokens.clear()
    assert annotate_sentence("cache-a", "same-sentence", "Red apple.").tokens
    second = annotate_sentence("cache-b", "same-sentence", "Red apple.")
    assert second.content_id == "cache-b"
    changed = annotate_sentence("cache-a", "same-sentence", "Better.")
    assert changed.sentence_text == "Better." and changed.candidates[0].kind == "flap"
    assert len(sound_service._cache) == 2
    lexicon = cmudict_lexicon.get_pronunciation_lexicon()
    monkeypatch.setattr(sound_service, "get_pronunciation_lexicon", lambda: replace(lexicon, version="next-lexicon"))
    assert annotate_sentence("cache-a", "same-sentence", "Better.").lexicon_version == "next-lexicon"
    monkeypatch.setattr(sound_service, "RULE_VERSION", "next-rules")
    annotate_sentence("cache-a", "same-sentence", "Better.")
    assert any(key[0] == "next-rules" for key in sound_service._cache)


def test_missing_or_corrupt_lexicon_is_explicit_and_recoverable(monkeypatch, tmp_path):
    monkeypatch.setattr(cmudict_lexicon, "_lexicon", None)
    dictionary_path = tmp_path / "missing.dict"
    monkeypatch.setattr(cmudict_lexicon, "LEXICON_PATH", dictionary_path)
    with pytest.raises(cmudict_lexicon.LexiconUnavailable):
        cmudict_lexicon.get_pronunciation_lexicon()
    dictionary_path.write_text("a AH0\n")
    with pytest.raises(cmudict_lexicon.LexiconUnavailable):
        cmudict_lexicon.get_pronunciation_lexicon()


def _put_blueprint(monkeypatch, content_id: str, text: str, *, legacy: bool = False):
    blueprint = Blueprint(
        id=f"bp-{content_id}", content_id=content_id, title="Sound fixture", summary="Fixture",
        logic_flow=[], key_points=[], scenario_suggestions=[],
        segmentation_version=None if legacy else "sentence-v2-test",
        transcript=[TranscriptLine(
            id="legacy-row" if legacy else "sound-row", time="0:01",
            parts=[HighlightedTranscriptPart(text=text, tag="sound-fixture", kind="chunk")],
        )],
    )
    monkeypatch.setitem(store.blueprints, content_id, blueprint)
    return blueprint


def test_sound_endpoint_uses_exact_shared_legacy_sentence_view_and_is_read_only(monkeypatch):
    blueprint = _put_blueprint(monkeypatch, "sound-legacy", "Red apple. Better plan.", legacy=True)
    before = blueprint.model_dump()
    shown = client.get("/api/blueprints/sound-legacy").json()
    assert len(shown["transcript"]) == 2
    sentence_id = shown["transcript"][0]["id"]
    response = client.get(f"/api/blueprints/sound-legacy/sentences/{sentence_id}/sound")
    assert response.status_code == 200
    result = response.json()
    assert result["sentence_id"] == sentence_id and result["sentence_text"] == "Red apple."
    assert result["provider"] == "cmudict-rules" and result["version"] == "sound-rules-v1"
    assert result["candidates"][0]["kind"] == "linking"
    assert blueprint.model_dump() == before
    assert client.get("/api/blueprints/sound-legacy/sentences/legacy-row/sound").status_code == 404


def test_endpoint_404s_are_checked_before_lexicon_loading(monkeypatch):
    _put_blueprint(monkeypatch, "sound-known", "Red apple.")
    def unexpected_lexicon():
        raise AssertionError("Unknown resources must not load the dictionary")
    monkeypatch.setattr(sound_service, "get_pronunciation_lexicon", unexpected_lexicon)
    assert client.get("/api/blueprints/sound-missing/sentences/sound-row/sound").status_code == 404
    assert client.get("/api/blueprints/sound-known/sentences/missing-row/sound").status_code == 404


def test_endpoint_reports_dictionary_unavailable_and_does_not_cache_error(monkeypatch):
    _put_blueprint(monkeypatch, "sound-unavailable", "Red apple.")
    real_loader = sound_service.get_pronunciation_lexicon
    def missing_lexicon():
        raise cmudict_lexicon.LexiconUnavailable("Sound dictionary is unavailable.")
    monkeypatch.setattr(sound_service, "get_pronunciation_lexicon", missing_lexicon)
    path = "/api/blueprints/sound-unavailable/sentences/sound-row/sound"
    assert client.get(path).status_code == 503
    monkeypatch.setattr(sound_service, "get_pronunciation_lexicon", real_loader)
    assert client.get(path).status_code == 200


def test_endpoint_has_no_client_text_or_media_input_and_rejects_oversized_source(monkeypatch):
    _put_blueprint(monkeypatch, "sound-authoritative", "Red apple.")
    path = "/api/blueprints/sound-authoritative/sentences/sound-row/sound"
    response = client.get(path, params={"text": "Ignore source. Better.", "audio": "bogus"})
    assert response.status_code == 200 and response.json()["sentence_text"] == "Red apple."
    assert client.post(path, json={"text": "Better."}).status_code == 405
    _put_blueprint(monkeypatch, "sound-long", "a" * 6001)
    assert client.get("/api/blueprints/sound-long/sentences/sound-row/sound").status_code == 422
