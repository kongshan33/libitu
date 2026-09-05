import re
from types import SimpleNamespace

from app.services import transcript_formatter


class FixedPunctuationEngine:
    def __init__(self, output: str) -> None:
        self.output = output

    def add_punctuation(self, _text: str) -> str:
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
        "So let's humanize, uh, Peter. See if we can get them to answer "
        "a little bit of a personal question? Then we'll go to their larger issues."
    )

    lines = transcript_formatter.format_transcript(transcript, "en", engine=engine)

    assert [line.time for line in lines] == ["0:04", "0:07", "0:12"]
    assert [line.text for line in lines] == [
        "So let's humanize, uh, Peter.",
        "See if we can get them to answer a little bit of a personal question?",
        "Then we'll go to their larger issues.",
    ]
    assert _words(" ".join(line.text for line in lines)) == _transcript_words(transcript)


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
