from dataclasses import asdict
from types import SimpleNamespace

import pytest

from app.schemas.analysis import AnalysisTranscriptPreviewLine
from app.services import sentence_formatter, transcript_formatter


class MergeAlthough:
    def should_merge(self, left, right, boundary_source):
        return left.lower().startswith("although") and "cautious" not in left


class Punctuation:
    def add_punctuation(self, text):
        return text.replace("improved", "improved.").replace("cautious", "cautious.").replace("tomorrow", "tomorrow.")


def test_syntax_merge_retains_full_source_and_timing_anchors():
    previews = []
    lines = transcript_formatter.format_transcript(
        "0:01\talthough the market improved\n0:05\twe remain cautious\n0:09\twe meet tomorrow",
        "en", previews.append, Punctuation(), syntax_engine=MergeAlthough(),
    )
    assert [line.text for line in lines] == [
        "Although the market improved we remain cautious.", "We meet tomorrow.",
    ]
    assert lines[0].source_token_start == 0 and lines[0].source_token_end == 7
    assert lines[0].start_ms == 1000 and lines[0].end_ms == 9000
    assert lines[0].boundary_source == "syntax_merge"
    assert all(asdict(old) == asdict(new) for batch in previews for old, new in zip(batch, lines))
    assert AnalysisTranscriptPreviewLine(time=lines[0].time, text=lines[0].text, **lines[0].metadata()).id == lines[0].id


def test_long_sentence_spans_windows_without_length_split(monkeypatch):
    monkeypatch.setattr(transcript_formatter, "get_settings", lambda: SimpleNamespace(
        punctuation_window_words=40, punctuation_overlap_words=5, transcript_preview_limit=300,
    ))
    words = [f"word{index}" for index in range(240)]

    class LongSentence:
        def add_punctuation(self, text):
            return text.replace("word239", "word239.")

    lines = transcript_formatter.format_transcript(
        "0:01\t" + " ".join(words), "en", engine=LongSentence(), syntax_engine=None,
    )
    assert len(lines) == 1
    assert lines[0].text.casefold() == " ".join(words) + "."
    assert lines[0].source_token_end == 240


def test_later_punctuation_failure_preserves_published_prefix(monkeypatch):
    monkeypatch.setattr(transcript_formatter, "get_settings", lambda: SimpleNamespace(
        punctuation_window_words=40, punctuation_overlap_words=5, transcript_preview_limit=300,
    ))

    class FailingWindow:
        calls = 0

        def add_punctuation(self, text):
            self.calls += 1
            if self.calls == 2:
                raise RuntimeError("private source must not be logged")
            return " ".join(word + ("." if int(word[4:]) % 5 == 4 else "") for word in text.split())

    previews = []
    lines = transcript_formatter.format_transcript(
        "0:01\t" + " ".join(f"word{i}" for i in range(90)), "en", previews.append,
        FailingWindow(), syntax_engine=None,
    )
    assert len(previews) >= 2
    for batch in previews:
        assert [asdict(line) for line in batch] == [asdict(line) for line in lines[:len(batch)]]
    assert " ".join(line.text for line in lines).lower().replace(".", "").split() == [f"word{i}" for i in range(90)]
    assert lines[-1].boundary_source == "unresolved"


def test_repeated_authored_sentences_keep_independent_ranges():
    lines = transcript_formatter.format_transcript(
        "0:01\tYes.\n0:01\tYes.\n0:03\tWe agree.", "en", syntax_engine=None,
    )
    assert [line.text for line in lines] == ["Yes.", "Yes.", "We agree."]
    assert len({line.id for line in lines}) == 3
    assert [(line.start_ms, line.end_ms) for line in lines[:2]] == [(1000, 2000), (2000, 3000)]


@pytest.mark.parametrize("source", ["0:01\tYes. Yes.", "0:01\nYes.\nYes."])
def test_repeated_words_inside_one_caption_are_not_deduplicated(source):
    lines = transcript_formatter.format_transcript(source, "en", syntax_engine=None)
    assert [line.text for line in lines] == ["Yes.", "Yes."]
    assert lines[0].source_token_end == lines[1].source_token_start == 1
    assert lines[0].id != lines[1].id


def test_real_source_long_sentence_and_abbreviations_are_preserved():
    text = "Dr. Smith explained that " + "the department reviewed the evidence and " * 12 + "we agreed."
    lines = transcript_formatter.format_transcript("0:01\t" + text, "en", syntax_engine=None)
    assert len(lines) == 1
    assert lines[0].text == text


def test_initialisms_before_lowercase_words_are_not_sentence_boundaries():
    lines = transcript_formatter.format_transcript(
        "0:01\tWe work with U.S. companies. We agree.", "en", syntax_engine=None,
    )
    assert [line.text for line in lines] == ["We work with U.S. companies.", "We agree."]


def test_unavailable_models_preserve_unfinished_tail_and_untimed_text(monkeypatch):
    monkeypatch.setattr(transcript_formatter, "get_punctuation_engine", lambda language: None)
    lines = transcript_formatter.format_transcript("we are still waiting for", "en", syntax_engine=None)
    assert len(lines) == 1 and lines[0].text == "We are still waiting for"
    assert lines[0].start_ms is None and lines[0].end_ms is None
    assert lines[0].boundary_source == "unresolved"


def test_missing_punctuation_does_not_claim_model_provenance(monkeypatch):
    monkeypatch.setattr(transcript_formatter, "get_punctuation_engine", lambda language: None)
    monkeypatch.setattr(transcript_formatter, "_has_reliable_source_punctuation", lambda lines: False)
    lines = transcript_formatter.format_transcript(
        "0:01\twe wait.\n0:02\tand continue", "en", syntax_engine=None,
    )
    assert [line.text for line in lines] == ["We wait.", "And continue"]
    assert all(line.boundary_source == "unresolved" for line in lines)
    assert all(line.boundary_confidence == "low" for line in lines)


def test_missing_syntax_does_not_change_trusted_source_boundaries():
    text = "0:01\tAlthough it is late. We can wait."
    lines = transcript_formatter.format_transcript(text, "en", syntax_engine=None)
    assert [line.text for line in lines] == ["Although it is late.", "We can wait."]
    assert all(line.boundary_source == "source_punctuation" for line in lines)


def test_trusted_source_does_not_load_syntax_or_punctuation(monkeypatch):
    from app.integrations import sentence_syntax

    def unexpected_load(language):
        raise AssertionError("Authored sentences must bypass model loading.")

    monkeypatch.setattr(sentence_syntax, "get_sentence_syntax", unexpected_load)
    monkeypatch.setattr(transcript_formatter, "get_punctuation_engine", unexpected_load)
    lines = transcript_formatter.format_transcript("0:01\tWe agree. We can proceed.", "en")
    assert len(lines) == 2
    assert all(line.segmentation_version == "sentence-v2-source" for line in lines)


def test_quoted_question_inside_source_sentence_does_not_split_surrounding_clause():
    text = 'Dr. Smith asked, "Really?" and waited for our reply. We answered.'
    lines = transcript_formatter.format_transcript("0:01\t" + text, "en", syntax_engine=None)
    assert [line.text for line in lines] == [
        'Dr. Smith asked, "Really?" and waited for our reply.', "We answered.",
    ]


def test_schema_rejects_malformed_versioned_ranges():
    with pytest.raises(ValueError):
        AnalysisTranscriptPreviewLine(time="0:01", text="Hello", segmentation_version="sentence-v2-spacy")


def test_preformatted_upgrade_does_not_remove_existing_words():
    lines = sentence_formatter.format_sentences(
        "0:01\tAh, we understand.", "en", source_is_formatted=True, syntax_engine=None,
    )
    assert lines[0].text == "Ah, we understand."
