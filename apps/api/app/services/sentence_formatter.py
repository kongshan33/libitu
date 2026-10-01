"""Source-preserving, append-only sentence formatting for both learning stages.

Processing windows bound inference, never the learner's sentence length. Only the
last candidate is provisional; finalized rows cannot be changed by later windows.
"""

import hashlib
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Protocol, cast

from app.schemas.captions import CaptionTrack, CaptionWordTiming
from app.services import transcript_formatter as captions


SEGMENTATION_VERSION = "sentence-v2"
_TERMINAL = re.compile(r"[.!?]+[\"'”’\)\]]*$")
_ABBREVIATION = re.compile(r"^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.$", re.I)


class SyntaxEngine(Protocol):
    def should_merge(self, left: str, right: str, boundary_source: str) -> bool: ...


@dataclass
class Token:
    text: str
    time: str
    start_ms: int | None = None
    end_ms: int | None = None
    timing_source: str = "caption_estimate"
    word_timing: CaptionWordTiming | None = None


def format_sentences(
    transcript_text: str,
    language: str | None = None,
    on_progress: captions.TranscriptProgressCallback | None = None,
    engine: captions.PunctuationEngine | None = None,
    *,
    syntax_engine: object = captions._AUTO_SYNTAX,
    source_is_formatted: bool = False,
    caption_track: CaptionTrack | None = None,
) -> list[captions.ParsedTranscriptLine]:
    # The caller checks video identity; only exact normalized text can receive
    # this track's timing. A mismatched optional track leaves the text usable.
    if caption_track is not None and not captions.caption_track_matches_text(caption_track, transcript_text, language):
        _log_failure("caption_track_text_mismatch", ValueError())
        caption_track = None
    lines = captions.parse_caption_track(caption_track, language) if caption_track is not None else captions.parse_transcript(transcript_text, preserve_rows=True)
    if caption_track is None and not source_is_formatted and (language is None or language.split("-", maxsplit=1)[0].casefold() == "en"):
        lines = captions.filter_filler_tokens(lines)
    if not lines:
        return []
    trusted_source = not source_is_formatted and (
        captions._has_reliable_source_punctuation(lines) or all(_TERMINAL.search(line.text) for line in lines)
    )
    if trusted_source:
        # No syntax inference is needed when authored punctuation owns boundaries.
        syntax_engine = None
    elif syntax_engine is captions._AUTO_SYNTAX:
        from app.integrations.sentence_syntax import get_sentence_syntax

        syntax_engine = get_sentence_syntax(language)
    mode = "source" if trusted_source else "spacy" if syntax_engine is not None else "fallback"
    version = f"{'sentence-v3' if caption_track is not None else SEGMENTATION_VERSION}-{mode}"
    tokens = _source_tokens(lines)
    if not tokens:
        return []
    fingerprint = hashlib.sha256(json.dumps(
        [version, source_is_formatted, [(t.text, t.time, t.start_ms, t.end_ms,
            t.word_timing.model_dump() if t.word_timing else None) for t in tokens]],
        ensure_ascii=False, separators=(",", ":"),
    ).encode()).hexdigest()[:16]
    reliable = source_is_formatted or trusted_source
    boundary_source = "punctuation_model" if source_is_formatted or not reliable else "source_punctuation"
    punctuation_engine = None if reliable else engine or captions.get_punctuation_engine(language)
    merger = _SentenceStream(tokens, fingerprint, version, cast(SyntaxEngine | None, syntax_engine), on_progress)
    words: list[str] = []
    begin = 0
    for index, (word, inferred) in enumerate(_formatted_words(tokens, punctuation_engine, reliable)):
        words.append(word)
        following = tokens[index + 1].text if index + 1 < len(tokens) else ""
        if _is_boundary(word, following):
            source = boundary_source if reliable or inferred else "unresolved"
            merger.accept(begin, index + 1, words, source)
            begin = index + 1
            words = []
    if words:
        # A video may end mid-sentence. Keep that source fragment without inventing
        # terminal punctuation or pretending it passed a completeness check.
        merger.accept(begin, len(tokens), words, "unresolved")
    merger.finish()
    return merger.rows


def _source_tokens(lines: list[captions.ParsedTranscriptLine]) -> list[Token]:
    if any(line.timing_source == "caption_event_estimate" for line in lines):
        return _caption_source_tokens(lines)
    tokens: list[Token] = []
    groups: list[tuple[int, list[Token]]] = []
    for line in lines:
        words = [Token(word, line.time) for word in line.text.split()]
        tokens.extend(words)
        seconds = captions.timestamp_seconds(line.time)
        if seconds is None:
            continue
        start = max(round(seconds * 1000), groups[-1][0] if groups else 0)
        if groups and start == groups[-1][0]:
            groups[-1][1].extend(words)
        else:
            groups.append((start, words))
    for index, (start, words) in enumerate(groups):
        if not words:
            continue
        end = groups[index + 1][0] if index + 1 < len(groups) else (
            start + max(2000, min(5000, len(words) * 250))
        )
        for offset, token in enumerate(words):
            token.start_ms = round(start + (end - start) * offset / len(words))
            token.end_ms = max(token.start_ms + 1, round(start + (end - start) * (offset + 1) / len(words)))
    return tokens


def _caption_source_tokens(lines: list[captions.ParsedTranscriptLine]) -> list[Token]:
    """Interpolate unknown navigation positions only between retained anchors."""
    tokens: list[Token] = []
    starts: list[int] = []
    for line in lines:
        starts.append(max(line.start_ms or 0, starts[-1] if starts else 0))
    next_starts: list[int | None] = [None] * len(lines)
    for index in range(len(lines) - 2, -1, -1):
        next_starts[index] = starts[index + 1] if starts[index + 1] > starts[index] else next_starts[index + 1]
    for row_index, line in enumerate(lines):
        words = line.text.split()
        if not words:
            continue
        start = starts[row_index]
        next_start = next_starts[row_index]
        end = line.end_ms if line.end_ms is not None and line.end_ms > start else (
            next_start if next_start is not None else start + max(2000, min(5000, len(words) * 250))
        )
        # Caption duration is screen occupancy, not evidence of speech through
        # the following event. Never let its coarse navigation range swallow a
        # later caption/sentence with an independently provided start.
        if next_start is not None:
            end = min(end, next_start)
        metadata = {word.source_token_index - len(tokens): word for word in line.word_timings or []}
        if next_start is not None and any(word.start_ms >= next_start for word in metadata.values()):
            metadata = {}
        next_word_start = next((word.start_ms for word in lines[row_index + 1].word_timings or []), None) if row_index + 1 < len(lines) else None
        for index, word in list(metadata.items()):
            if word.end_ms is not None and word.end_ms > end:
                metadata[index] = word.model_copy(update={
                    "end_ms": end if next_word_start == end else None,
                    "end_source": "next_word_estimate" if next_word_start == end else None,
                })
        # Never adjust the actual retained starts to match interpolated positions.
        end = max(end, max((word.start_ms + 1 for word in metadata.values()), default=end))
        anchors = {0: start, len(words): end}
        anchors.update({index: word.start_ms for index, word in metadata.items()})
        ordered = sorted(anchors.items())
        boundaries = [start] * (len(words) + 1)
        for (left, left_ms), (right, right_ms) in zip(ordered, ordered[1:]):
            for index in range(left, right + 1):
                boundaries[index] = round(left_ms + (right_ms - left_ms) * (index - left) / (right - left))
        for index, word in enumerate(words):
            timing = metadata.get(index)
            nav_start = boundaries[index]
            nav_end = timing.end_ms if timing and timing.end_ms is not None else max(nav_start + 1, boundaries[index + 1])
            tokens.append(Token(word, line.time, nav_start, nav_end, "caption_event_estimate", timing))
    # An event-end estimate can overlap the next event's word start. Cap that
    # estimate only at a retained next-word start, never at an interpolated one.
    for current, following in zip(tokens, tokens[1:]):
        if current.word_timing and following.word_timing and current.word_timing.end_ms is not None:
            if current.word_timing.start_ms < following.word_timing.start_ms < current.word_timing.end_ms:
                current.word_timing = current.word_timing.model_copy(update={
                    "end_ms": following.word_timing.start_ms, "end_source": "next_word_estimate",
                })
                current.end_ms = following.word_timing.start_ms
    return tokens


def _formatted_words(
    tokens: list[Token], engine: captions.PunctuationEngine | None, reliable: bool,
) -> Iterator[tuple[str, bool]]:
    if engine is None or reliable:
        yield from ((token.text, False) for token in tokens)
        return
    settings = captions.get_settings()
    window_size = settings.punctuation_window_words
    overlap = min(settings.punctuation_overlap_words, window_size // 3)
    cursor = 0
    while cursor < len(tokens):
        window_start = max(0, cursor - overlap)
        window_end = min(len(tokens), cursor + window_size)
        source = [captions.SourceToken(
            text=captions._strip_external_punctuation(token.text),
            model_text=re.sub(r"[,.;:!?]", "", token.text), time=token.time,
        ) for token in tokens[window_start:window_end]]
        try:
            predicted = engine.add_punctuation(" ".join(token.model_text for token in source))
            aligned = captions._align_formatted_tokens(source, predicted)
            if aligned is None:
                raise ValueError("Punctuation changed source tokens.")
        except Exception as error:
            _log_failure("punctuation_format_fallback", error)
            # Keep the emitted prefix. Falling back over the entire transcript here
            # would invalidate the sentences already visible through SSE.
            yield from ((token.text, False) for token in tokens[cursor:])
            return
        stable_end = window_end if window_end == len(tokens) else window_end - overlap
        for index in range(cursor, stable_end):
            offset = index - window_start
            yield captions._apply_predicted_punctuation(source[offset].text, aligned[offset]), True
        cursor = stable_end


def _is_boundary(word: str, following: str = "") -> bool:
    if not _TERMINAL.search(word):
        return False
    return not (
        _ABBREVIATION.fullmatch(word)
        or re.fullmatch(r"[A-Z]\.", word)
        or (re.fullmatch(r"(?:[A-Za-z]\.){2,}", word) and following[:1].islower())
        # A quoted question/exclamation may be embedded in a continuing clause:
        # 'She asked, "Really?" and waited.' The source's closing quote is not
        # itself evidence that the surrounding sentence is finished.
        or (re.search(r"[.!?]+[\"'”’\)\]]+$", word) and following[:1].islower())
    )


class _SentenceStream:
    def __init__(
        self, tokens: list[Token], fingerprint: str, version: str,
        syntax: SyntaxEngine | None, callback: captions.TranscriptProgressCallback | None,
    ) -> None:
        self.tokens = tokens
        self.fingerprint = fingerprint
        self.version = version
        self.syntax = syntax
        self.callback = callback
        self.rows: list[captions.ParsedTranscriptLine] = []
        self.pending: tuple[int, int, str, str, bool] | None = None
        self.last_preview_count = 0

    def accept(self, start: int, end: int, words: list[str], source: str) -> None:
        text = " ".join(words)
        if self.pending:
            left_start, left_end, left_text, left_source, merged = self.pending
            join = False
            if self.syntax is not None:
                try:
                    join = self.syntax.should_merge(left_text, text, left_source)
                except Exception as error:
                    _log_failure("sentence_syntax_fallback", error)
                    self.syntax = None
            if join:
                left_text = re.sub(r"[.!?]+(?=[\"'”’\)\]]*$)", "", left_text)
                self.pending = (left_start, end, f"{left_text} {text}", source, True)
                return
            self._publish(left_start, left_end, left_text, left_source, merged)
        self.pending = (start, end, text, source, False)

    def _publish(self, start: int, end: int, text: str, source: str, merged: bool) -> None:
        text = captions._capitalize_sentence_start(captions.normalize_punctuation(text))
        first, last = self.tokens[start], self.tokens[end - 1]
        token_range = self.tokens[start:end]
        bounds = [token.end_ms for token in token_range if token.end_ms is not None]
        interval_end = max(bounds) if bounds else None
        timed = first.start_ms is not None and interval_end is not None and interval_end > first.start_ms
        word_timings = [token.word_timing for token in token_range if token.word_timing is not None]
        display_words = text.split()
        aligned_text = len(display_words) == len(token_range) and all(
            captions._normalized_token(display) == captions._normalized_token(token.text)
            for display, token in zip(display_words, token_range)
        )
        if not timed or not aligned_text:
            word_timings = []
        else:
            word_timings = [word.model_copy(update={"text": display_words[word.source_token_index - start]}) for word in word_timings]
            if any(word.start_ms < first.start_ms or word.start_ms >= interval_end or (word.end_ms or 0) > interval_end for word in word_timings):
                word_timings = []
        timing_source = "caption_word_offsets" if word_timings else (
            "caption_event_estimate" if any(token.timing_source == "caption_event_estimate" for token in token_range) else "caption_estimate"
        )
        confidence = "low" if source == "unresolved" else "high" if source == "source_punctuation" and not merged else "medium"
        self.rows.append(captions.ParsedTranscriptLine(
            time=captions.format_timestamp_ms(first.start_ms) if timed and self.version.startswith("sentence-v3") else first.time, text=text,
            id=f"{self.version}-{self.fingerprint}-{start}-{end}",
            segmentation_version=self.version,
            source_token_start=start, source_token_end=end,
            start_ms=first.start_ms if timed else None,
            end_ms=interval_end if timed else None,
            boundary_source="syntax_merge" if merged and source != "unresolved" else source,
            boundary_confidence=confidence,
            timing_source=timing_source, word_timings=word_timings or None,
        ))
        # Avoid quadratic preview publication for long transcripts. The first
        # confirmed sentence is immediate; subsequent batches contain eight rows.
        if len(self.rows) == 1 or len(self.rows) - self.last_preview_count >= 8:
            self._emit()

    def _emit(self) -> None:
        if self.callback is None or len(self.rows) == self.last_preview_count:
            return
        self.last_preview_count = len(self.rows)
        try:
            self.callback(self.rows[:captions.get_settings().transcript_preview_limit])
        except Exception as error:
            _log_failure("transcript_progress_callback_failed", error)

    def finish(self) -> None:
        if self.pending:
            self._publish(*self.pending)
            self.pending = None
        self._emit()


def _log_failure(event: str, error: Exception) -> None:
    print(json.dumps({"event": event, "exception_type": type(error).__name__}), flush=True)
