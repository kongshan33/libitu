import json
import re
from collections.abc import Callable
from dataclasses import dataclass

from app.config import get_settings
from app.integrations.local_punctuation import PunctuationEngine, get_punctuation_engine


@dataclass(frozen=True)
class ParsedTranscriptLine:
    time: str
    text: str


@dataclass(frozen=True)
class SourceToken:
    text: str
    time: str


TranscriptProgressCallback = Callable[[list[ParsedTranscriptLine]], None]

TIMESTAMP_PATTERN = re.compile(r"^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[\t ]+(.+)$")
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+")
SENTENCE_END = re.compile(r"[.!?][\"')\]]?$")
PUNCTUATION_ONLY = re.compile(r"^[,.;:!?]+$")
INITIAL_DISCOURSE_MARKER = re.compile(
    r"^(to be fair|that said|having said that|even so|in other words|for example|"
    r"frankly|interestingly enough|broadly speaking|for the most part|above all)\b(?!,)",
    re.I,
)


def format_transcript(
    transcript_text: str,
    language: str | None = None,
    on_progress: TranscriptProgressCallback | None = None,
    engine: PunctuationEngine | None = None,
) -> list[ParsedTranscriptLine]:
    source_lines = parse_transcript(transcript_text)
    if not source_lines:
        return []

    punctuation_engine = engine or get_punctuation_engine(language)
    if punctuation_engine is None:
        formatted = merge_transcript_fragments(source_lines)
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
        formatted = merge_transcript_fragments(source_lines)
        _emit_progress(on_progress, formatted)
    return formatted


def parse_transcript(transcript_text: str) -> list[ParsedTranscriptLine]:
    raw_lines = [line.strip() for line in transcript_text.splitlines() if line.strip()]
    if len(raw_lines) == 1:
        raw_lines = [
            sentence.strip()
            for sentence in SENTENCE_BOUNDARY.split(raw_lines[0])
            if sentence.strip()
        ]

    parsed: list[ParsedTranscriptLine] = []
    for raw_line in raw_lines:
        match = TIMESTAMP_PATTERN.match(raw_line)
        if match:
            hours, minutes, seconds, text = match.groups()
            time = (
                f"{int(minutes)}:{seconds}"
                if hours is None
                else f"{int(hours)}:{int(minutes):02d}:{seconds}"
            )
            parsed.append(ParsedTranscriptLine(time=time, text=text.strip()))
        else:
            parsed.append(ParsedTranscriptLine(time="--:--", text=raw_line))
    return parsed


def serialize_transcript(lines: list[ParsedTranscriptLine]) -> str:
    return "\n".join(f"{line.time}\t{line.text}" for line in lines)


def merge_transcript_fragments(
    lines: list[ParsedTranscriptLine],
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
            or (SENTENCE_END.search(pending[-1]) is not None and word_count >= 6)
        )
        if should_start_new:
            flush()
            start_time = line.time
        elif not pending:
            start_time = line.time

        pending.append(line.text)
        word_count += len(words)
        previous_seconds = seconds if seconds is not None else previous_seconds
        if SENTENCE_END.search(line.text) is not None and word_count >= 6:
            flush()

    flush()
    return merged


def punctuate_sentence(value: str, end_punctuation: str | None = None) -> str:
    text = " ".join(value.split())
    text = re.sub(r"\bi\b", "I", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\b(uh|um)\b", r", \1,", text, flags=re.I)
    text = re.sub(r"\s*,\s*,\s*", ", ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\s{2,}", " ", text).strip(" ,")
    text = INITIAL_DISCOURSE_MARKER.sub(r"\1,", text)
    first_letter = re.search(r"[A-Za-z]", text)
    if first_letter is not None:
        index = first_letter.start()
        text = f"{text[:index]}{text[index].upper()}{text[index + 1:]}"
    if text and end_punctuation is not None:
        text = re.sub(r"[.!?]+$", "", text).rstrip()
        text = f"{text}{end_punctuation}"
    elif text and SENTENCE_END.search(text) is None:
        text = f"{text}."
    return text


def timestamp_seconds(timestamp: str) -> int | None:
    try:
        components = [int(component) for component in timestamp.split(":")]
    except ValueError:
        return None
    if len(components) not in (2, 3):
        return None
    return sum(
        component * (60**index)
        for index, component in enumerate(reversed(components))
    )


def _format_with_engine(
    source_lines: list[ParsedTranscriptLine],
    engine: PunctuationEngine,
    *,
    window_words: int,
    overlap_words: int,
    on_progress: TranscriptProgressCallback | None,
) -> list[ParsedTranscriptLine]:
    source_tokens = [
        SourceToken(text=word, time=line.time)
        for line in source_lines
        for word in line.text.split()
    ]
    if not source_tokens:
        return []

    formatted: list[ParsedTranscriptLine] = []
    cursor = 0
    while cursor < len(source_tokens):
        window_start = max(0, cursor - overlap_words)
        window_end = min(len(source_tokens), cursor + window_words)
        window = source_tokens[window_start:window_end]
        output = engine.add_punctuation(" ".join(token.text for token in window))
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
        _normalized_token(source.text) != _normalized_token(output_token)
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
    words = formatted_tokens[start - window_start : end - window_start + 1]
    text = " ".join(words)
    text = re.sub(
        r"([,;:]\s+)(Uh|Um)(?=[,.;!?])",
        lambda match: f"{match.group(1)}{match.group(2).lower()}",
        text,
    )
    if force_terminal:
        text = punctuate_sentence(text)
    else:
        text = re.sub(r"\s+([,.;:!?])", r"\1", text).strip()
        first_letter = re.search(r"[A-Za-z]", text)
        if first_letter is not None:
            index = first_letter.start()
            text = f"{text[:index]}{text[index].upper()}{text[index + 1:]}"
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


def _emit_progress(
    callback: TranscriptProgressCallback | None,
    lines: list[ParsedTranscriptLine],
) -> None:
    if callback is None:
        return
    limit = get_settings().transcript_preview_limit
    try:
        callback(lines[:limit])
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
