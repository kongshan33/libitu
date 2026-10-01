import json
import re
from bisect import bisect_right
from collections.abc import Callable
from dataclasses import dataclass, field

from app.config import get_settings
from app.integrations.local_punctuation import PunctuationEngine, get_punctuation_engine
from app.schemas.captions import CaptionTrack, CaptionWordTiming


@dataclass(frozen=True)
class ParsedTranscriptLine:
    time: str
    text: str
    id: str | None = field(default=None, compare=False)
    segmentation_version: str | None = field(default=None, compare=False)
    source_token_start: int | None = field(default=None, compare=False)
    source_token_end: int | None = field(default=None, compare=False)
    start_ms: int | None = field(default=None, compare=False)
    end_ms: int | None = field(default=None, compare=False)
    boundary_source: str | None = field(default=None, compare=False)
    boundary_confidence: str | None = field(default=None, compare=False)
    timing_source: str | None = field(default=None, compare=False)
    word_timings: list[CaptionWordTiming] | None = field(default=None, compare=False)

    def metadata(self) -> dict:
        result = {name: getattr(self, name) for name in (
            "id", "segmentation_version", "source_token_start", "source_token_end",
            "start_ms", "end_ms", "boundary_source", "boundary_confidence", "timing_source", "word_timings",
        ) if getattr(self, name) is not None}
        if self.word_timings is not None:
            result["word_timings"] = [word.model_dump() for word in self.word_timings]
        return result


@dataclass(frozen=True)
class SourceToken:
    text: str
    model_text: str
    time: str


TranscriptProgressCallback = Callable[[list[ParsedTranscriptLine]], None]

TIMESTAMP_PATTERN = re.compile(r"^(?:(\d{1,3}):)?(\d{1,2}):(\d{2}(?:\.\d{1,3})?)[\t ]+(.+)$")
TIMESTAMP_ONLY_PATTERN = re.compile(r"^(?:(\d{1,3}):)?(\d{1,2}):(\d{2}(?:\.\d{1,3})?)$")
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+")
SENTENCE_END = re.compile(r"[.!?][\"')\]]?$")
SOURCE_SENTENCE_END = re.compile(r"[.!?][\"')\]]?(?:\s|$)")
PUNCTUATION_ONLY = re.compile(r"^[,.;:!?]+$")
WORD_TOKEN = re.compile(r"\b\w+(?:['’]\w+)*\b", re.UNICODE)
FILLER_TOKENS = frozenset({"um", "uh", "er", "ah"})
MAX_WORDS_PER_RELIABLE_SENTENCE = 45
DISCOURSE_MARKERS = (
    "on the other hand",
    "to be fair",
    "that said",
    "having said that",
    "even so",
    "in other words",
    "for example",
    "frankly",
    "interestingly enough",
    "broadly speaking",
    "for the most part",
    "above all",
)


_AUTO_SYNTAX = object()


def format_transcript(
    transcript_text: str,
    language: str | None = None,
    on_progress: TranscriptProgressCallback | None = None,
    engine: PunctuationEngine | None = None,
    *,
    syntax_engine: object = _AUTO_SYNTAX,
    caption_track: CaptionTrack | None = None,
) -> list[ParsedTranscriptLine]:
    from app.services.sentence_formatter import format_sentences

    return format_sentences(
        transcript_text, language, on_progress, engine,
        syntax_engine=syntax_engine, caption_track=caption_track,
    )


def format_legacy_transcript(
    transcript_text: str,
    language: str | None = None,
    on_progress: TranscriptProgressCallback | None = None,
    engine: PunctuationEngine | None = None,
) -> list[ParsedTranscriptLine]:
    source_lines = parse_transcript(transcript_text)
    if language is None or language.split("-", maxsplit=1)[0].casefold() == "en":
        source_lines = filter_filler_tokens(source_lines)
    if not source_lines:
        return []

    if _has_reliable_source_punctuation(source_lines):
        formatted = _finalize_transcript(
            merge_transcript_fragments(source_lines, respect_source_sentences=True)
        )
        _emit_progress(on_progress, formatted)
        return formatted

    punctuation_engine = engine or get_punctuation_engine(language)
    if punctuation_engine is None:
        formatted = _finalize_transcript(merge_transcript_fragments(source_lines))
        _emit_progress(on_progress, formatted)
        return formatted

    settings = get_settings()
    try:
        formatted = _format_with_engine(
            source_lines,
            punctuation_engine,
            window_words=settings.punctuation_window_words,
            overlap_words=min(
                settings.punctuation_overlap_words,
                settings.punctuation_window_words // 3,
            ),
            on_progress=on_progress,
        )
        formatted = _finalize_transcript(formatted)
    except Exception as error:
        print(
            json.dumps(
                {
                    "event": "punctuation_format_fallback",
                    "exception_type": type(error).__name__,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
        formatted = _finalize_transcript(merge_transcript_fragments(source_lines))
        _emit_progress(on_progress, formatted)
    return formatted


def parse_transcript(
    transcript_text: str, *, preserve_rows: bool = False,
) -> list[ParsedTranscriptLine]:
    raw_lines = [line.strip() for line in transcript_text.splitlines() if line.strip()]
    if len(raw_lines) == 1:
        raw_lines = [
            sentence.strip()
            for sentence in SENTENCE_BOUNDARY.split(raw_lines[0])
            if sentence.strip()
        ]

    parsed: list[ParsedTranscriptLine] = []
    active_time: str | None = None
    for raw_line in raw_lines:
        match = TIMESTAMP_PATTERN.match(raw_line)
        if match:
            hours, minutes, seconds, text = match.groups()
            active_time = _format_parsed_timestamp(hours, minutes, seconds)
            if preserve_rows:
                parsed.append(ParsedTranscriptLine(time=active_time, text=text.strip()))
            else:
                _append_or_merge_line(parsed, active_time, text.strip())
            continue

        timestamp_match = TIMESTAMP_ONLY_PATTERN.match(raw_line)
        if timestamp_match:
            active_time = _format_parsed_timestamp(*timestamp_match.groups())
            continue

        if active_time is not None:
            if preserve_rows:
                parsed.append(ParsedTranscriptLine(time=active_time, text=raw_line))
            else:
                _append_or_merge_line(parsed, active_time, raw_line)
        else:
            parsed.append(ParsedTranscriptLine(time="--:--", text=raw_line))
    return parsed


def filter_filler_tokens(
    lines: list[ParsedTranscriptLine],
) -> list[ParsedTranscriptLine]:
    filtered: list[ParsedTranscriptLine] = []
    for line in lines:
        text = _remove_filler_tokens(line.text)
        if text:
            filtered.append(ParsedTranscriptLine(time=line.time, text=text))
    return filtered


def merge_transcript_lines_by_timestamp(
    lines: list[ParsedTranscriptLine],
) -> list[ParsedTranscriptLine]:
    merged: list[ParsedTranscriptLine] = []
    for line in lines:
        if merged and line.time != "--:--" and merged[-1].time == line.time:
            previous = merged[-1]
            merged[-1] = ParsedTranscriptLine(
                time=previous.time,
                text=_merge_caption_text(previous.text, line.text),
            )
        else:
            merged.append(line)
    return merged


def serialize_transcript(lines: list[ParsedTranscriptLine]) -> str:
    return "\n".join(f"{line.time}\t{line.text}" for line in lines)


def merge_transcript_fragments(
    lines: list[ParsedTranscriptLine],
    *,
    respect_source_sentences: bool = False,
) -> list[ParsedTranscriptLine]:
    if not lines:
        return []

    merged: list[ParsedTranscriptLine] = []
    pending: list[str] = []
    start_time = lines[0].time
    previous_seconds: int | None = None
    word_count = 0

    def flush() -> None:
        nonlocal pending, word_count
        if not pending:
            return
        merged.append(
            ParsedTranscriptLine(
                time=start_time,
                text=punctuate_sentence(" ".join(pending)),
            )
        )
        pending = []
        word_count = 0

    for line in lines:
        seconds = timestamp_seconds(line.time)
        words = line.text.split()
        gap = (
            seconds - previous_seconds
            if seconds is not None and previous_seconds is not None
            else 0
        )
        should_start_new = bool(pending) and (
            word_count + len(words) > 30
            or (gap >= 4 and word_count >= 12)
            or (
                SENTENCE_END.search(pending[-1]) is not None
                and (respect_source_sentences or word_count >= 6)
            )
        )
        if should_start_new:
            flush()
            start_time = line.time
        elif not pending:
            start_time = line.time

        pending.append(line.text)
        word_count += len(words)
        previous_seconds = seconds if seconds is not None else previous_seconds
        if SENTENCE_END.search(line.text) is not None and (
            respect_source_sentences or word_count >= 6
        ):
            flush()

    flush()
    return merged


def punctuate_sentence(value: str, end_punctuation: str | None = None) -> str:
    text = normalize_punctuation(value)
    text = re.sub(r"\bi\b", "I", text)
    text = _capitalize_sentence_start(text)
    if text and end_punctuation is not None:
        text = _set_terminal_punctuation(text, end_punctuation)
    elif text and SENTENCE_END.search(text) is None:
        text = f"{text}."
    return normalize_punctuation(text)


def normalize_punctuation(value: str) -> str:
    text = " ".join(value.split())
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", text)
    text = re.sub(r"[,;:]+(?=\s*[.!?])", "", text)
    text = re.sub(r"\.{2,}", ".", text)
    text = re.sub(r"!{2,}", "!", text)
    text = re.sub(r"\?{2,}", "?", text)
    text = re.sub(r"([.!?])(?:\s*[.!?])+", r"\1", text)
    text = _normalize_initial_discourse_marker(text)
    text = re.sub(r"([,;:!?])(?=[A-Za-z])", r"\1 ", text)
    return re.sub(r"\s{2,}", " ", text).strip(" ,;:")


def timestamp_seconds(timestamp: str) -> float | None:
    if not re.fullmatch(r"\d+(?::\d{2}){1,2}(?:\.\d{1,3})?", timestamp):
        return None
    components = [float(component) for component in timestamp.split(":")]
    return sum(
        component * (60**index)
        for index, component in enumerate(reversed(components))
    )


def format_timestamp_ms(milliseconds: int) -> str:
    total_seconds, remainder_ms = divmod(max(0, milliseconds), 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    time = f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"
    return f"{time}.{remainder_ms:03d}" if remainder_ms else time


def caption_track_to_text(track: CaptionTrack) -> str:
    """Source text only: never infer words, discard repeated speech, or strip fillers."""
    return "\n".join(
        f"{format_timestamp_ms(event.tStartMs)}\t{text}"
        for event in track.events
        if (text := " ".join("".join(segment.utf8 for segment in event.segs).split()))
    )


def caption_track_matches_text(track: CaptionTrack, text: str, language: str | None = None) -> bool:
    """Compare ordered normalized lexical content, ignoring timestamps/case/punctuation.

    This only permits rebuilding an existing text view from its own source.
    Repeated words remain repeated; no fuzzy matching or subsequence acceptance.
    """
    def words(value: str) -> list[str]:
        lines = parse_transcript(value, preserve_rows=True)
        if not language or language.replace("_", "-").split("-", 1)[0].casefold() == "en":
            lines = filter_filler_tokens(lines)
        return [word.group().casefold().replace("’", "'") for line in lines for word in WORD_TOKEN.finditer(line.text)]

    return words(caption_track_to_text(track)) == words(text)


def parse_caption_track(track: CaptionTrack, language: str | None = None) -> list[ParsedTranscriptLine]:
    """Retain event timing and only structurally supported single-word offsets.

    JSON3 identifies a representation, not a timing capability. No timestamp
    difference here is interpreted as acoustic silence. Uncertain source data
    always keeps its text and event-level navigation fallback.
    """
    english = not language or language.replace("_", "-").split("-", 1)[0].casefold() == "en"
    rows: list[ParsedTranscriptLine] = []
    token_index = 0
    text_events = [
        (index, event, "".join(segment.utf8 for segment in event.segs))
        for index, event in enumerate(track.events)
        if any(segment.utf8.strip() for segment in event.segs)
    ]
    # Explicit rolling updates do not define a one-to-one spoken-word sequence.
    # Keep their text intact; do not guess which repeated tokens were spoken twice.
    unsafe_events = {index for index, event, _ in text_events if event.aAppend == 1}
    for previous, current in zip(text_events, text_events[1:]):
        previous_index, prior, prior_text = previous
        index, event, text = current
        if event.tStartMs <= prior.tStartMs or prior.aAppend == 1 or event.aAppend == 1:
            unsafe_events.update((previous_index, index))
        if (prior.wWinId is not None and prior.wWinId == event.wWinId
                and prior.dDurationMs and event.tStartMs < prior.tStartMs + prior.dDurationMs
                and " ".join(text.split()).startswith(" ".join(prior_text.split()))):
            unsafe_events.update((previous_index, index))

    for event_index, event, raw in text_events:
        text = _remove_filler_tokens(raw) if english else " ".join(raw.split())
        if not text:
            continue
        raw_words = list(re.finditer(r"\S+", raw))
        # Associate a whitespace word with exactly one segment that itself
        # contains exactly that word. Split contractions and multiword segments
        # deliberately have no word-offset claim.
        segment_ranges = []
        cursor = 0
        for segment_index, segment in enumerate(event.segs):
            segment_ranges.append((cursor, cursor + len(segment.utf8), segment_index, segment))
            cursor += len(segment.utf8)
        segment_starts = [item[0] for item in segment_ranges]
        nonempty_segments = [(i, segment) for i, segment in enumerate(event.segs) if segment.utf8.strip()]
        explicit_offsets = [segment.tOffsetMs for _, segment in nonempty_segments if segment.tOffsetMs is not None]
        valid_offsets = all(offset >= 0 and (event.dDurationMs is None or offset < event.dDurationMs) for offset in explicit_offsets)
        valid_offsets = valid_offsets and all(left < right for left, right in zip(explicit_offsets, explicit_offsets[1:]))
        can_use_words = track.version == "youtube-json3-v1" and event_index not in unsafe_events and valid_offsets
        first_segment_index = nonempty_segments[0][0] if nonempty_segments else None
        proves_fine_grained = len(nonempty_segments) > 1 and any(offset > 0 for offset in explicit_offsets)
        candidates: list[tuple[int, int] | None] = []
        normalized_words: list[str] = []
        normalized_raw_indexes: list[int] = []
        for raw_index, word in enumerate(raw_words):
            segment_position = bisect_right(segment_starts, word.start()) - 1
            source_segment = segment_ranges[segment_position] if segment_position >= 0 else None
            candidate = None
            if can_use_words and source_segment is not None and source_segment[1] >= word.end():
                _, _, segment_index, segment = source_segment
                if len(segment.utf8.split()) == 1 and len(WORD_TOKEN.findall(word.group())) == 1:
                    offset = segment.tOffsetMs
                    if offset is None and segment_index == first_segment_index and proves_fine_grained:
                        offset = 0
                    if offset is not None:
                        candidate = (event.tStartMs + offset, segment_index)
            candidates.append(candidate)
            cleaned = _remove_filler_tokens(word.group()) if english else word.group()
            if cleaned:
                normalized_words.append(cleaned)
                normalized_raw_indexes.append(raw_index)
        word_timings = []
        if normalized_words == text.split():
            for index, (word, raw_index) in enumerate(zip(normalized_words, normalized_raw_indexes)):
                candidate = candidates[raw_index]
                # Removing a filler inside a token changes which sound began
                # at its offset; only unchanged lexical tokens retain starts.
                if candidate is None or _normalized_token(word) != _normalized_token(raw_words[raw_index].group()):
                    continue
                start_ms, segment_index = candidate
                end_ms = None
                end_source = None
                following = candidates[raw_index + 1] if raw_index + 1 < len(candidates) else None
                if following and following[0] > start_ms:
                    end_ms, end_source = following[0], "next_word_estimate"
                elif raw_index == len(raw_words) - 1 and event.dDurationMs and event.tStartMs + event.dDurationMs > start_ms:
                    end_ms, end_source = event.tStartMs + event.dDurationMs, "event_end_estimate"
                word_timings.append(CaptionWordTiming(
                    source_token_index=token_index + index, text=word, start_ms=start_ms,
                    end_ms=end_ms, end_source=end_source,
                    source_event_index=event_index, source_seg_index=segment_index,
                ))
        event_end = event.tStartMs + event.dDurationMs if event.dDurationMs else None
        rows.append(ParsedTranscriptLine(
            time=format_timestamp_ms(event.tStartMs), text=text,
            source_token_start=token_index, source_token_end=token_index + len(text.split()),
            start_ms=event.tStartMs, end_ms=event_end,
            timing_source="caption_event_estimate", word_timings=word_timings or None,
        ))
        token_index += len(text.split())
    # Cross-event repetitions/overlaps can pass per-event checks. Never sort
    # words into a new source sequence or expose nonmonotonic starts as precise.
    affected: set[int] = set()
    previous: tuple[int, CaptionWordTiming] | None = None
    for row_index, row in enumerate(rows):
        for word in row.word_timings or []:
            if previous and word.start_ms <= previous[1].start_ms:
                affected.update((previous[0], row_index))
            previous = (row_index, word)
    return [
        ParsedTranscriptLine(**{**row.__dict__, "word_timings": None}) if index in affected else row
        for index, row in enumerate(rows)
    ]


def _format_parsed_timestamp(
    hours: str | None,
    minutes: str,
    seconds: str,
) -> str:
    if hours is None:
        return f"{int(minutes)}:{seconds}"
    return f"{int(hours)}:{int(minutes):02d}:{seconds}"


def _append_or_merge_line(
    lines: list[ParsedTranscriptLine],
    time: str,
    text: str,
) -> None:
    if lines and time != "--:--" and lines[-1].time == time:
        previous = lines[-1]
        lines[-1] = ParsedTranscriptLine(
            time=time,
            text=_merge_caption_text(previous.text, text),
        )
        return
    lines.append(ParsedTranscriptLine(time=time, text=text))


def _merge_caption_text(previous: str, current: str) -> str:
    previous = " ".join(previous.split())
    current = " ".join(current.split())
    previous_folded = previous.casefold()
    current_folded = current.casefold()
    if (
        not previous
        or previous_folded == current_folded
        or previous_folded.startswith(current_folded)
    ):
        return previous or current
    if current_folded.startswith(previous_folded):
        return current
    return f"{previous} {current}"


def _remove_filler_tokens(text: str) -> str:
    filler_spans = [
        match.span()
        for match in WORD_TOKEN.finditer(text)
        if match.group().casefold() in FILLER_TOKENS
    ]
    if not filler_spans:
        return " ".join(text.split())

    pieces: list[str] = []
    cursor = 0
    for start, end in filler_spans:
        pieces.append(text[cursor:start])
        cursor = end
    pieces.append(text[cursor:])
    cleaned = "".join(pieces)
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", cleaned)
    cleaned = re.sub(r"[,;:]+(?=[.!?])", "", cleaned)
    cleaned = re.sub(r"^[\s,.;:!?]+|[\s,;:]+$", "", cleaned)
    return " ".join(cleaned.split())


def _has_reliable_source_punctuation(
    lines: list[ParsedTranscriptLine],
) -> bool:
    text = " ".join(line.text for line in lines)
    word_count = len(WORD_TOKEN.findall(text))
    sentence_end_count = len(SOURCE_SENTENCE_END.findall(text))
    return bool(sentence_end_count) and (
        word_count <= sentence_end_count * MAX_WORDS_PER_RELIABLE_SENTENCE
    )


def _finalize_transcript(
    lines: list[ParsedTranscriptLine],
) -> list[ParsedTranscriptLine]:
    merged = merge_transcript_lines_by_timestamp(lines)
    return [
        ParsedTranscriptLine(time=line.time, text=text)
        for line in merged
        if (text := normalize_punctuation(line.text))
    ]


def _format_with_engine(
    source_lines: list[ParsedTranscriptLine],
    engine: PunctuationEngine,
    *,
    window_words: int,
    overlap_words: int,
    on_progress: TranscriptProgressCallback | None,
) -> list[ParsedTranscriptLine]:
    source_tokens = _build_source_tokens(source_lines)
    if not source_tokens:
        return []

    formatted: list[ParsedTranscriptLine] = []
    cursor = 0
    while cursor < len(source_tokens):
        window_start = max(0, cursor - overlap_words)
        window_end = min(len(source_tokens), cursor + window_words)
        window = source_tokens[window_start:window_end]
        output = engine.add_punctuation(" ".join(token.model_text for token in window))
        formatted_tokens = _align_formatted_tokens(window, output)
        if formatted_tokens is None:
            raise ValueError("The punctuation model changed the source word sequence.")

        is_final_window = window_end == len(source_tokens)
        stable_end = (
            len(source_tokens) - 1
            if is_final_window
            else max(cursor, window_end - overlap_words - 1)
        )
        sentence_start = cursor
        scan_index = cursor
        while scan_index <= stable_end:
            formatted_token = formatted_tokens[scan_index - window_start]
            sentence_word_count = scan_index - sentence_start + 1
            if SENTENCE_END.search(formatted_token) is not None:
                _append_sentence(
                    formatted,
                    source_tokens,
                    formatted_tokens,
                    sentence_start,
                    scan_index,
                    window_start,
                )
                sentence_start = scan_index + 1
            elif sentence_word_count >= 35:
                forced_end = _choose_forced_end(
                    source_tokens,
                    formatted_tokens,
                    sentence_start,
                    scan_index,
                    window_start,
                )
                _append_sentence(
                    formatted,
                    source_tokens,
                    formatted_tokens,
                    sentence_start,
                    forced_end,
                    window_start,
                    force_terminal=True,
                )
                sentence_start = forced_end + 1
                scan_index = sentence_start
                continue
            scan_index += 1

        if is_final_window and sentence_start < len(source_tokens):
            _append_sentence(
                formatted,
                source_tokens,
                formatted_tokens,
                sentence_start,
                len(source_tokens) - 1,
                window_start,
                force_terminal=True,
            )
            sentence_start = len(source_tokens)

        if sentence_start == cursor:
            forced_end = min(stable_end, cursor + 29)
            _append_sentence(
                formatted,
                source_tokens,
                formatted_tokens,
                cursor,
                forced_end,
                window_start,
                force_terminal=True,
            )
            sentence_start = forced_end + 1

        cursor = sentence_start
        _emit_progress(on_progress, formatted)

    return formatted


def _align_formatted_tokens(
    source_tokens: list[SourceToken],
    output: str,
) -> list[str] | None:
    output_tokens: list[str] = []
    for token in output.split():
        if PUNCTUATION_ONLY.fullmatch(token) and output_tokens:
            output_tokens[-1] = f"{output_tokens[-1]}{token}"
        else:
            output_tokens.append(token)
    if len(output_tokens) != len(source_tokens):
        return None
    if any(
        _normalized_token(source.model_text) != _normalized_token(output_token)
        for source, output_token in zip(source_tokens, output_tokens, strict=True)
    ):
        return None
    return output_tokens


def _append_sentence(
    result: list[ParsedTranscriptLine],
    source_tokens: list[SourceToken],
    formatted_tokens: list[str],
    start: int,
    end: int,
    window_start: int,
    *,
    force_terminal: bool = False,
) -> None:
    words = [
        _apply_predicted_punctuation(
            source_tokens[index].text,
            formatted_tokens[index - window_start],
        )
        for index in range(start, end + 1)
    ]
    text = " ".join(words)
    if force_terminal:
        text = punctuate_sentence(text)
    else:
        text = _capitalize_sentence_start(normalize_punctuation(text))
    result.append(ParsedTranscriptLine(time=source_tokens[start].time, text=text))


def _choose_forced_end(
    source_tokens: list[SourceToken],
    formatted_tokens: list[str],
    start: int,
    limit: int,
    window_start: int,
) -> int:
    first_candidate = min(limit, start + 19)
    for index in range(limit, first_candidate - 1, -1):
        token = formatted_tokens[index - window_start]
        current_seconds = timestamp_seconds(source_tokens[index].time)
        next_seconds = (
            timestamp_seconds(source_tokens[index + 1].time)
            if index + 1 < len(source_tokens)
            else None
        )
        if token.endswith((",", ";", ":")):
            return index
        if (
            current_seconds is not None
            and next_seconds is not None
            and next_seconds - current_seconds >= 2
        ):
            return index
    return limit


def _normalized_token(value: str) -> str:
    return "".join(re.findall(r"[a-z0-9]+", value.casefold()))


def _build_source_tokens(
    lines: list[ParsedTranscriptLine],
) -> list[SourceToken]:
    tokens: list[SourceToken] = []
    for line in lines:
        for word in line.text.split():
            source_text = _strip_external_punctuation(word)
            model_text = re.sub(r"[,.;:!?]", "", source_text)
            if not _normalized_token(model_text):
                continue
            tokens.append(
                SourceToken(
                    text=source_text,
                    model_text=model_text,
                    time=line.time,
                )
            )
    return tokens


def _strip_external_punctuation(value: str) -> str:
    text = re.sub(r"^[,.;:!?]+", "", value)
    return re.sub(r"[,.;:!?]+(?=[\"')\]]*$)", "", text)


def _apply_predicted_punctuation(source_text: str, formatted_token: str) -> str:
    match = re.search(r"([,.;:!?]+)(?=[\"')\]]*$)", formatted_token)
    if match is None:
        return source_text
    punctuation = _normalize_punctuation_run(match.group(1))
    closing_match = re.search(r"[\"')\]]+$", source_text)
    if closing_match is None:
        return f"{source_text}{punctuation}"
    index = closing_match.start()
    return f"{source_text[:index]}{punctuation}{source_text[index:]}"


def _normalize_punctuation_run(value: str) -> str:
    terminal = [character for character in value if character in ".!?"]
    if terminal:
        return terminal[0]
    separators = [character for character in value if character in ",;:"]
    return separators[0] if separators else ""


def _normalize_initial_discourse_marker(value: str) -> str:
    text = value
    for marker in DISCOURSE_MARKERS:
        words = [re.escape(word) for word in marker.split()]
        flexible_marker = r"\s*,?\s+".join(words)
        pattern = re.compile(
            rf"(?P<prefix>^|(?<=[.!?])\s+)"
            rf"(?P<marker>{flexible_marker})(?:\s*,)*(?!\w)",
            re.I,
        )

        def replace(match: re.Match[str]) -> str:
            normalized_marker = re.sub(r"\s*,\s*", " ", match.group("marker"))
            return f"{match.group('prefix')}{normalized_marker},"

        text = pattern.sub(replace, text)
    return text


def _capitalize_sentence_start(value: str) -> str:
    first_word = WORD_TOKEN.search(value)
    if first_word is None:
        return value
    word = first_word.group()
    if word.casefold() == "i":
        replacement = "I"
    elif word.islower():
        replacement = f"{word[0].upper()}{word[1:]}"
    else:
        return value
    return f"{value[:first_word.start()]}{replacement}{value[first_word.end():]}"


def _set_terminal_punctuation(value: str, punctuation: str) -> str:
    match = re.search(r"(?P<terminal>[.!?]+)?(?P<closing>[\"')\]]*)$", value)
    if match is None:
        return f"{value}{punctuation}"
    return f"{value[:match.start()]}{punctuation}{match.group('closing')}"


def _emit_progress(
    callback: TranscriptProgressCallback | None,
    lines: list[ParsedTranscriptLine],
) -> None:
    if callback is None:
        return
    limit = get_settings().transcript_preview_limit
    try:
        callback(merge_transcript_lines_by_timestamp(lines)[:limit])
    except Exception as error:
        print(
            json.dumps(
                {
                    "event": "transcript_progress_callback_failed",
                    "exception_type": type(error).__name__,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
