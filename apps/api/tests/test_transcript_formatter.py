import re
from types import SimpleNamespace

from app.services import transcript_formatter


class FixedPunctuationEngine:
    def __init__(self, output: str) -> None:
        self.output = output
        self.inputs: list[str] = []

    def add_punctuation(self, text: str) -> str:
        self.inputs.append(text)
        return self.output


def test_local_model_splits_sentences_and_keeps_source_timestamps(monkeypatch) -> None:
    _use_test_settings(monkeypatch)
    transcript = (
        "0:04\tso let's humanize uh Peter\n"
        "0:07\tsee if we can get them to answer\n"
        "0:09\ta little bit of a personal question\n"
        "0:12\tthen we'll go to their larger issues"
    )
    engine = FixedPunctuationEngine(
        "So let's humanize Peter. See if we can get them to answer "
        "a little bit of a personal question? Then we'll go to their larger issues."
    )

    lines = transcript_formatter.format_transcript(transcript, "en", engine=engine)

    assert [line.time for line in lines] == ["0:04", "0:07", "0:12"]
    assert [line.text for line in lines] == [
        "So let's humanize Peter.",
        "See if we can get them to answer a little bit of a personal question?",
        "Then we'll go to their larger issues.",
    ]
    assert _words(" ".join(line.text for line in lines)) == [
        word for word in _transcript_words(transcript) if word != "uh"
    ]
    assert engine.inputs == [
        "so let's humanize Peter see if we can get them to answer "
        "a little bit of a personal question then we'll go to their larger issues"
    ]


def test_filler_filter_removes_only_complete_tokens(monkeypatch) -> None:
    _use_test_settings(monkeypatch)
    transcript = (
        "0:01\tUm, this umbrella is useful, uh.\n"
        "0:03\tWe need er clarity and ah context."
    )
    engine = FixedPunctuationEngine(
        "This umbrella is useful. We need clarity and context."
    )

    lines = transcript_formatter.format_transcript(transcript, "en", engine=engine)

    assert [line.text for line in lines] == [
        "This umbrella is useful.",
        "We need clarity and context.",
    ]
    assert "umbrella" in lines[0].text
    assert not (
        {"um", "uh", "er", "ah"}
        & set(_words(" ".join(line.text for line in lines)))
    )


def test_filler_filter_does_not_change_non_english_transcripts(monkeypatch) -> None:
    _use_test_settings(monkeypatch)
    transcript = "0:01\tah bon this phrase keeps its source words"
    engine = FixedPunctuationEngine("Ah bon, this phrase keeps its source words.")

    lines = transcript_formatter.format_transcript(transcript, "fr", engine=engine)

    assert lines == [
        transcript_formatter.ParsedTranscriptLine(
            time="0:01",
            text="Ah bon, this phrase keeps its source words.",
        )
    ]


def test_parser_merges_same_timestamp_and_untimestamped_continuations() -> None:
    transcript = (
        "0:01\tfirst caption line\n"
        "second visual line\n"
        "0:01\tthird visual line\n"
        "0:03\n"
        "timestamp-only continuation\n"
        "0:05\tnext caption"
    )

    lines = transcript_formatter.parse_transcript(transcript)

    assert lines == [
        transcript_formatter.ParsedTranscriptLine(
            time="0:01",
            text="first caption line second visual line third visual line",
        ),
        transcript_formatter.ParsedTranscriptLine(
            time="0:03",
            text="timestamp-only continuation",
        ),
        transcript_formatter.ParsedTranscriptLine(time="0:05", text="next caption"),
    ]


def test_formatter_groups_sentences_that_share_a_source_timestamp(monkeypatch) -> None:
    _use_test_settings(monkeypatch)
    transcript = "0:01\tfirst thought ends here and another thought follows now"
    engine = FixedPunctuationEngine(
        "First thought ends here. And another thought follows now."
    )

    lines = transcript_formatter.format_transcript(transcript, "en", engine=engine)

    assert lines == [
        transcript_formatter.ParsedTranscriptLine(
            time="0:01",
            text="First thought ends here. And another thought follows now.",
        )
    ]


def test_reliable_source_punctuation_bypasses_model_and_is_normalized(monkeypatch) -> None:
    _use_test_settings(monkeypatch)
    transcript = "0:01\ton, the other hand,, we can proceed,, now."
    engine = FixedPunctuationEngine("This model output must not be used.")

    lines = transcript_formatter.format_transcript(transcript, "en", engine=engine)

    assert lines == [
        transcript_formatter.ParsedTranscriptLine(
            time="0:01",
            text="On the other hand, we can proceed, now.",
        )
    ]
    assert engine.inputs == []


def test_unpunctuated_source_uses_clean_model_input_and_source_word_case(monkeypatch) -> None:
    _use_test_settings(monkeypatch)
    transcript = "0:01\ton, the other hand,, iPhone works well today"
    engine = FixedPunctuationEngine(
        "ON, the other hand,, IPHONE works well today."
    )

    lines = transcript_formatter.format_transcript(transcript, "en", engine=engine)

    assert engine.inputs == ["on the other hand iPhone works well today"]
    assert lines == [
        transcript_formatter.ParsedTranscriptLine(
            time="0:01",
            text="On the other hand, iPhone works well today.",
        )
    ]


def test_model_rewrite_falls_back_without_losing_source_words(monkeypatch) -> None:
    _use_test_settings(monkeypatch)
    transcript = "0:01\tthis wording must remain exact\n0:04\teven when formatting fails"
    engine = FixedPunctuationEngine(
        "This wording should remain exact, even when formatting fails."
    )

    lines = transcript_formatter.format_transcript(transcript, "en", engine=engine)

    rendered = " ".join(line.text for line in lines)
    assert "must" in rendered
    assert "should" not in rendered
    assert _words(rendered) == _transcript_words(transcript)
    assert rendered.endswith(".")


def test_progress_publishes_cumulative_sentence_batches(monkeypatch) -> None:
    _use_test_settings(monkeypatch, window_words=40, overlap_words=5)
    source_words = [f"word{index}" for index in range(75)]

    class WindowEngine:
        def add_punctuation(self, text: str) -> str:
            words = text.split()
            return " ".join(
                f"{word}." if (index + 1) % 10 == 0 else word
                for index, word in enumerate(words)
            )

    previews = []
    lines = transcript_formatter.format_transcript(
        f"0:01\t{' '.join(source_words)}",
        "en",
        previews.append,
        WindowEngine(),
    )

    assert len(previews) >= 2
    assert previews[-1] == lines
    assert all(len(left) <= len(right) for left, right in zip(previews, previews[1:]))
    assert _words(" ".join(line.text for line in lines)) == source_words


def _use_test_settings(
    monkeypatch,
    *,
    window_words: int = 120,
    overlap_words: int = 20,
) -> None:
    monkeypatch.setattr(
        transcript_formatter,
        "get_settings",
        lambda: SimpleNamespace(
            punctuation_window_words=window_words,
            punctuation_overlap_words=overlap_words,
            transcript_preview_limit=300,
        ),
    )


def _words(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", value.casefold())


def _transcript_words(value: str) -> list[str]:
    return _words(" ".join(line.split("\t", maxsplit=1)[-1] for line in value.splitlines()))
