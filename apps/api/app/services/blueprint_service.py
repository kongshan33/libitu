import math
import re
import hashlib
from collections import OrderedDict
from threading import Lock
from dataclasses import dataclass
from typing import cast
from uuid import NAMESPACE_URL, uuid5

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.analysis import (
    AnalysisCorpusItem,
    BlueprintAnalysis,
    LearnerLevel,
)
from app.schemas.blueprint import (
    Blueprint,
    BlueprintSegment,
    CorpusItem,
    HighlightedTranscriptPart,
    LogicNode,
    TranscriptLine,
)
from app.schemas.content import ContentResolveResponse
from app.schemas.captions import CaptionTrack
from app.services import store
from app.services.caption_source import caption_fingerprint, get_caption_track
from app.services.transcript_formatter import (
    ParsedTranscriptLine,
    merge_transcript_fragments,
    parse_transcript,
    timestamp_seconds,
    caption_track_matches_text,
    caption_track_to_text,
    format_transcript,
)


# Derived views do not rewrite old persisted blueprints or rerun semantic analysis.
_sentence_views: OrderedDict[str, Blueprint] = OrderedDict()
_sentence_views_lock = Lock()
_MAX_SENTENCE_VIEWS = 8
_AUTO_CAPTION_TRACK = object()


@dataclass(frozen=True)
class LanguagePattern:
    phrase: str
    tags: tuple[str, ...]
    description: str


CHUNK_PATTERNS = (
    LanguagePattern("to be fair", ("acknowledging", "softening"), "conceding before a counterpoint"),
    LanguagePattern("on the other hand", ("contrast", "discourse"), "introducing a contrasting view"),
    LanguagePattern("at the same time", ("contrast", "discourse"), "holding two ideas together"),
    LanguagePattern("in other words", ("reframing", "discourse"), "restating an idea more clearly"),
    LanguagePattern("the point is", ("framing", "discourse"), "bringing attention to the main claim"),
    LanguagePattern("for example", ("justifying", "discourse"), "introducing supporting evidence"),
    LanguagePattern("I would say", ("hedging", "softening"), "softening a personal assessment"),
    LanguagePattern("I think", ("hedging", "discourse"), "marking a claim as a personal view"),
    LanguagePattern("I guess", ("hedging", "softening"), "lowering certainty before a claim"),
    LanguagePattern("you know", ("discourse", "softening"), "maintaining conversational flow"),
)

STRUCTURE_PATTERNS = (
    (re.compile(r"\bnot\s+(.{1,80}?)\s+but\s+(?:rather\s+)?(.{1,100}?)(?:[.!?]|$)", re.I), "not [A], but rather [B]", ("contrast", "reframing")),
    (re.compile(r"\bthe reason\s+(.{1,80}?)\s+is\s+(?:that\s+)?(.{1,100}?)(?:[.!?]|$)", re.I), "The reason [situation] is that [explanation]", ("justifying", "framing")),
    (re.compile(r"\bif\s+(.{1,80}?),\s*then\s+(.{1,100}?)(?:[.!?]|$)", re.I), "If [condition], then [result]", ("justifying", "framing")),
)

VALID_TAGS = {
    "acknowledging",
    "clarifying",
    "conceding",
    "contrast",
    "discourse",
    "emphasising",
    "framing",
    "hedging",
    "idiom",
    "justifying",
    "proposing",
    "reframing",
    "redirecting",
    "softening",
    "summarising",
    "summarizing",
    "transitioning",
}
LEVEL_ORDER: dict[LearnerLevel, int] = {
    "A1": 0,
    "A2": 1,
    "B1": 2,
    "B2": 3,
    "C1": 4,
    "C2": 5,
}

MIN_SEGMENT_DURATION_MS = 45_000
MAX_SEGMENT_DURATION_MS = 5 * 60_000
TARGET_SEGMENT_DURATION_MS = 3 * 60_000
ESTIMATED_TAIL_MIN_MS = 2_000
ESTIMATED_TAIL_MAX_MS = 5_000
PHONOLOGY_TAG_HINTS = (
    ("link", "lk"),
    ("weak", "wk"),
    ("flap", "ft"),
    ("elision", "el"),
    ("assimilat", "as"),
    ("glottal", "gl"),
    ("drop-d", "dd"),
    ("drop d", "dd"),
    ("h-drop", "hd"),
    ("h drop", "hd"),
    ("vowel", "vl"),
    ("voic", "vc"),
)


def get_blueprint(content_id: str) -> Blueprint | None:
    settings = get_settings()
    if settings.queue_is_configured:
        queued_blueprint = processing_queue.get_blueprint(content_id, settings.analysis_version)
        if queued_blueprint is not None:
            return queued_blueprint
        repository = get_supabase_repository()
        return (
            repository.get_blueprint(content_id, settings.analysis_version)
            if repository is not None
            else None
        )
    return store.blueprints.get(content_id)


def personalize_blueprint(
    blueprint: Blueprint,
    learner_level: LearnerLevel | None,
    corpus_limit: int = 12,
) -> Blueprint:
    blueprint = _with_unified_sentences(blueprint)
    selected_items = _select_corpus_items(blueprint.corpus_items, learner_level, corpus_limit)
    segments = blueprint.segments
    if not any(segment.start_ms is not None and segment.end_ms is not None for segment in segments):
        legacy_lines = [
            ParsedTranscriptLine(time=line.time, text=_transcript_text(line))
            for line in blueprint.transcript
        ]
        segments = _build_segments(
            blueprint.content_id,
            blueprint.analysis_version,
            legacy_lines,
            blueprint.logic_flow,
            blueprint.corpus_items,
        )
    transcript = [
        line.model_copy(update={"parts": _highlight_corpus_parts(_transcript_text(line), selected_items)})
        for line in blueprint.transcript
    ]
    return blueprint.model_copy(
        update={
            "corpus_items": selected_items,
            "transcript": transcript,
            "segments": segments,
        }
    )


def create_blueprint(content: ContentResolveResponse, transcript_text: str) -> Blueprint:
    parsed_lines = parse_transcript(transcript_text)
    track = store.content_caption_tracks.get(content.content_id)
    readable_lines = (
        format_transcript(transcript_text, content.language, caption_track=track)
        if track is not None else merge_transcript_fragments(parsed_lines)
    )
    corpus_items = _extract_corpus_items(parsed_lines)
    transcript = _annotate_transcript(readable_lines)
    if track is not None:
        transcript = [TranscriptLine(
            time=line.time, parts=_highlight_corpus_parts(line.text, corpus_items), **line.metadata(),
        ) for line in readable_lines]
    logic_flow = _build_logic_flow(readable_lines)
    title = content.title or "Untitled YouTube video"

    blueprint = Blueprint(
        id=f"blueprint_{content.content_id}",
        content_id=content.content_id,
        analysis_version=get_settings().analysis_version,
        segmentation_version=readable_lines[0].segmentation_version if readable_lines else None,
        caption_fingerprint=caption_fingerprint(track) if track is not None else None,
        title=title,
        source_url=content.source_url,
        summary=_build_summary(title, parsed_lines),
        logic_flow=logic_flow,
        chapters=[node.title for node in logic_flow],
        transcript=transcript,
        corpus_items=corpus_items,
        key_points=[node.subtitle for node in logic_flow],
        scenario_suggestions=["Explain the main idea", "Respond with a contrasting view", "Summarize the takeaway"],
        segments=_build_segments(
            content.content_id,
            get_settings().analysis_version,
            readable_lines,
            logic_flow,
            corpus_items,
        ),
    )
    store.blueprints[content.content_id] = blueprint
    return blueprint


def create_blueprint_from_analysis(
    content: ContentResolveResponse,
    transcript_text: str,
    analysis: BlueprintAnalysis,
    analysis_version: str | None = None,
    formatted_transcript_text: str | None = None,
    *,
    formatted_lines: list[ParsedTranscriptLine] | None = None,
) -> Blueprint:
    analysis_version = analysis_version or get_settings().analysis_version
    parsed_lines = parse_transcript(transcript_text)
    readable_lines = formatted_lines if formatted_lines is not None else (
        parse_transcript(formatted_transcript_text)
        if formatted_transcript_text
        else merge_transcript_fragments(parsed_lines)
    )
    analyzed_corpus_items = _evidenced_analysis_items(
        analysis.corpus_items,
        readable_lines,
    )
    logic_flow = [
        LogicNode(
            id=f"logic-{index + 1}",
            title=node.title,
            subtitle=node.subtitle,
            time=node.timestamp,
        )
        for index, node in enumerate(analysis.logic_flow)
    ]
    corpus_items = [
        CorpusItem(
            id=f"{item.kind}-{index + 1}",
            kind=item.kind,
            text=f'"{item.text}" - {item.meaning}' if item.kind in {"chunk", "idiom"} else item.text,
            tags=_valid_tags(item.tags),
            meta=f"{item.timestamp or '--:--'} - {item.level} - click + to save",
            meaning=item.meaning,
            usage_note=item.usage_note,
            source_text=item.source_text,
            pattern_family=item.pattern_family,
            level=item.level,
            usage_register=item.usage_register,
            scenario_tags=item.scenario_tags,
            phonology_note=item.phonology_note,
            naturalness_score=item.naturalness_score,
            transferability_score=item.transferability_score,
            learning_value_score=item.learning_value_score,
        )
        for index, item in enumerate(analyzed_corpus_items)
    ]
    transcript = [
        TranscriptLine(
            **{**line.metadata(), "id": line.id or _logic_id_for_time(line.time, logic_flow)},
            time=line.time,
            parts=_highlight_corpus_parts(line.text, corpus_items),
        )
        for line in readable_lines
    ]
    blueprint = Blueprint(
        id=str(uuid5(NAMESPACE_URL, f"blueprint:{content.content_id}:{analysis_version}")),
        content_id=content.content_id,
        analysis_version=analysis_version,
        segmentation_version=next((line.segmentation_version for line in readable_lines if line.segmentation_version), None),
        title=content.title or "Untitled YouTube video",
        source_url=content.source_url,
        summary=analysis.summary,
        logic_flow=logic_flow,
        chapters=analysis.chapters,
        transcript=transcript,
        corpus_items=corpus_items,
        key_points=analysis.key_points,
        scenario_suggestions=analysis.scenario_suggestions,
        segments=_build_segments(
            content.content_id,
            analysis_version,
            readable_lines,
            logic_flow,
            corpus_items,
        ),
    )
    return blueprint


def _with_unified_sentences(
    blueprint: Blueprint, *, caption_track: CaptionTrack | None | object = _AUTO_CAPTION_TRACK,
) -> Blueprint:
    """Upgrade legacy display rows in a bounded local cache, retaining corpus snapshots.

    Old rows no longer carry punctuation provenance or internal caption anchors.
    Treat their marks as model candidates and their times as estimates. The stored
    semantic analysis stays immutable; a new formatter run retains richer anchors.
    """
    from app.services.sentence_formatter import SEGMENTATION_VERSION

    if not blueprint.transcript:
        return blueprint
    track = (
        get_caption_track(blueprint.content_id, include_durable=blueprint.caption_fingerprint is None)
        if caption_track is _AUTO_CAPTION_TRACK else cast(CaptionTrack | None, caption_track)
    )
    fingerprint = caption_fingerprint(track) if track is not None else None
    if fingerprint is not None and fingerprint == blueprint.caption_fingerprint:
        return blueprint
    # Timing upgrades may reuse semantic analysis only for the very same spoken
    # source words. A different caption track must never retime unrelated evidence.
    if track is not None and not caption_track_matches_text(
        track, "\n".join(_transcript_text(line) for line in blueprint.transcript), track.language,
    ):
        track = None
        fingerprint = None
    if track is None and (
        blueprint.segmentation_version
        and blueprint.segmentation_version.startswith((f"{SEGMENTATION_VERSION}-", "sentence-v3-"))
    ):
        return blueprint
    payload = blueprint.model_dump_json() + (fingerprint or "")
    key = hashlib.sha256(payload.encode()).hexdigest()
    # Holding this lock prevents duplicate cold work on concurrent legacy reads.
    with _sentence_views_lock:
        if key in _sentence_views:
            _sentence_views.move_to_end(key)
            return _sentence_views[key]
        result = build_caption_timing_view(blueprint, track)
        _sentence_views[key] = result
        while len(_sentence_views) > _MAX_SENTENCE_VIEWS:
            _sentence_views.popitem(last=False)
        return result


def build_caption_timing_view(blueprint: Blueprint, track: CaptionTrack | None) -> Blueprint:
    """Build a source-bound derived view without publishing or changing caches.

    Recovery uses this preflight before any write; normal blueprint reads cache
    the same derived representation through ``_with_unified_sentences``.
    """
    from app.services.sentence_formatter import format_sentences

    source_text = caption_track_to_text(track) if track is not None else "\n".join(
        f"{line.time}\t{_transcript_text(line)}" if timestamp_seconds(line.time) is not None
        else _transcript_text(line)
        for line in blueprint.transcript
    )
    lines = format_sentences(
        source_text, track.language if track is not None else "en",
        source_is_formatted=track is None, caption_track=track,
    )
    if not lines:
        return blueprint
    transcript = [TranscriptLine(
        time=line.time, parts=_highlight_corpus_parts(line.text, blueprint.corpus_items),
        **line.metadata(),
    ) for line in lines]
    return blueprint.model_copy(update={
        "transcript": transcript,
        "segmentation_version": lines[0].segmentation_version,
        "caption_fingerprint": caption_fingerprint(track) if track is not None else None,
        "segments": _build_segments(
            blueprint.content_id, blueprint.analysis_version, lines,
            blueprint.logic_flow, blueprint.corpus_items,
        ),
    })


def find_blueprint_sentence(blueprint: Blueprint, sentence_id: str) -> TranscriptLine | None:
    """Resolve an exact server-owned sentence, including an active old snapshot.

    Timing recovery does not replace a learner's active Stage 2 recording. Its
    old sentence ID remains valid only inside this same semantic source, never
    through client-supplied text or decoded token coordinates.
    """
    track = get_caption_track(blueprint.content_id)
    if track is not None and not caption_track_matches_text(
        track, "\n".join(_transcript_text(line) for line in blueprint.transcript), track.language,
    ):
        return None
    current = _with_unified_sentences(blueprint, caption_track=track)
    line = next((row for row in current.transcript if row.id == sentence_id), None)
    if line is not None:
        return line
    # Only a verified timing-only source upgrade enables compatibility fallback.
    if track is None:
        return None
    line = next((row for row in blueprint.transcript if row.id == sentence_id), None)
    if line is not None:
        return line
    legacy = _with_unified_sentences(blueprint, caption_track=None)
    return next((row for row in legacy.transcript if row.id == sentence_id), None)


def build_local_transcript_preview(
    transcript_text: str,
    limit: int = 50,
) -> list[ParsedTranscriptLine]:
    return merge_transcript_fragments(parse_transcript(transcript_text))[:limit]


def _build_summary(title: str, lines: list[ParsedTranscriptLine]) -> str:
    preview = " ".join(line.text for line in lines[:3])
    if len(preview) > 360:
        preview = f"{preview[:357].rstrip()}..."
    return f'{title} begins with: {preview}'


def _build_logic_flow(lines: list[ParsedTranscriptLine]) -> list[LogicNode]:
    if not lines:
        return []

    count = min(5, len(lines))
    indexes = sorted({round(index * (len(lines) - 1) / max(count - 1, 1)) for index in range(count)})
    labels = ("Opening", "Development", "Key idea", "Implication", "Takeaway")
    nodes: list[LogicNode] = []
    for position, line_index in enumerate(indexes):
        line = lines[line_index]
        subtitle = line.text if len(line.text) <= 96 else f"{line.text[:93].rstrip()}..."
        nodes.append(
            LogicNode(
                id=f"logic-{position + 1}",
                title=labels[min(position, len(labels) - 1)],
                subtitle=subtitle,
                time=None if line.time == "--:--" else line.time,
            )
        )
    return nodes


def _build_segments(
    content_id: str,
    analysis_version: str,
    lines: list[ParsedTranscriptLine],
    logic_flow: list[LogicNode],
    corpus_items: list[CorpusItem],
) -> list[BlueprintSegment]:
    """Build contiguous practice ranges from timestamped transcript sentences.

    Segment boundaries are kept on transcript-line boundaries. The final end time is
    estimated from the last caption because the current content contract does not
    carry the source video's duration.
    """
    if not lines:
        return []

    timed_indexes = [index for index, line in enumerate(lines) if timestamp_seconds(line.time) is not None]
    if not timed_indexes:
        segments = [
            _make_segment(
                content_id,
                analysis_version,
                1,
                0,
                len(lines),
                lines,
                logic_flow[0] if logic_flow else None,
                corpus_items,
                None,
            )
        ]
        return _mark_recommended_segment(segments)

    total_end_ms = _estimated_transcript_end_ms(lines, timed_indexes)
    boundary_nodes = _initial_segment_boundaries(
        lines,
        timed_indexes,
        logic_flow,
        total_end_ms,
    )
    boundaries = sorted({0, *boundary_nodes, len(lines)})
    boundaries = _merge_short_segments(boundaries, lines, total_end_ms)
    boundaries = _split_long_segments(boundaries, lines, total_end_ms)

    node_by_boundary = {
        index: node
        for index, node in _logic_boundary_nodes(lines, timed_indexes, logic_flow)
    }
    segments: list[BlueprintSegment] = []
    previous_node_id: str | None = None
    part_by_node: dict[str, int] = {}
    for sequence, (start_index, end_index) in enumerate(
        zip(boundaries, boundaries[1:]),
        start=1,
    ):
        node = _node_for_boundary(start_index, node_by_boundary)
        node_id = node.id if node is not None else None
        if node_id is not None:
            part_by_node[node_id] = part_by_node.get(node_id, 0) + 1
            part = part_by_node[node_id]
        else:
            part = 1

        title = node.title if node is not None else f"Practice segment {sequence}"
        if node_id is not None and node_id == previous_node_id and part > 1:
            title = f"{title} · Part {part}"
        summary = (
            node.subtitle
            if node is not None
            else "A transcript segment selected for focused shadowing."
        )
        segments.append(
            _make_segment(
                content_id,
                analysis_version,
                sequence,
                start_index,
                end_index,
                lines,
                node,
                corpus_items,
                total_end_ms,
                title=title,
                summary=summary,
            )
        )
        previous_node_id = node_id

    return _mark_recommended_segment(segments)


def _logic_boundary_nodes(
    lines: list[ParsedTranscriptLine],
    timed_indexes: list[int],
    logic_flow: list[LogicNode],
) -> list[tuple[int, LogicNode]]:
    timed_ms = {
        index: lines[index].start_ms if lines[index].start_ms is not None else timestamp_seconds(lines[index].time) * 1000
        for index in timed_indexes
    }
    positioned: list[tuple[int, LogicNode]] = []
    for node in logic_flow:
        timestamp_ms = _timestamp_ms(node.time)
        if timestamp_ms is None:
            continue
        index = min(
            timed_indexes,
            key=lambda candidate: (abs(timed_ms[candidate] - timestamp_ms), candidate),
        )
        positioned.append((index, node))

    positioned.sort(key=lambda item: (item[0], item[1].id))
    unique: list[tuple[int, LogicNode]] = []
    seen_indexes: set[int] = set()
    for index, node in positioned:
        if index in seen_indexes:
            continue
        seen_indexes.add(index)
        unique.append((index, node))
    return unique


def _initial_segment_boundaries(
    lines: list[ParsedTranscriptLine],
    timed_indexes: list[int],
    logic_flow: list[LogicNode],
    total_end_ms: int,
) -> list[int]:
    positioned = _logic_boundary_nodes(lines, timed_indexes, logic_flow)
    if positioned:
        return [index for index, _ in positioned]

    if logic_flow:
        count = min(len(logic_flow), 6)
        target_times = [total_end_ms * index // count for index in range(count)]
    else:
        count = max(1, min(6, math.ceil(total_end_ms / TARGET_SEGMENT_DURATION_MS)))
        target_times = [total_end_ms * index // count for index in range(count)]

    timed_ms = {
        index: lines[index].start_ms if lines[index].start_ms is not None else timestamp_seconds(lines[index].time) * 1000
        for index in timed_indexes
    }
    return [
        min(timed_indexes, key=lambda candidate: (abs(timed_ms[candidate] - target), candidate))
        for target in target_times
    ]


def _merge_short_segments(
    boundaries: list[int],
    lines: list[ParsedTranscriptLine],
    total_end_ms: int,
) -> list[int]:
    boundaries = list(boundaries)
    while len(boundaries) > 2:
        durations = [
            _boundary_time_ms(boundaries[index + 1], lines, total_end_ms)
            - _boundary_time_ms(boundaries[index], lines, total_end_ms)
            for index in range(len(boundaries) - 1)
        ]
        short_index = next(
            (index for index, duration in enumerate(durations) if duration < MIN_SEGMENT_DURATION_MS),
            None,
        )
        if short_index is None:
            break

        removal_options = [
            boundary_index
            for boundary_index in (short_index, short_index + 1)
            if 0 < boundary_index < len(boundaries) - 1
        ]
        safe_options = [
            boundary_index
            for boundary_index in removal_options
            if _boundary_time_ms(boundaries[boundary_index + 1], lines, total_end_ms)
            - _boundary_time_ms(boundaries[boundary_index - 1], lines, total_end_ms)
            <= MAX_SEGMENT_DURATION_MS
        ]
        if not safe_options:
            break

        best_option = min(
            safe_options,
            key=lambda boundary_index: abs(
                (
                    _boundary_time_ms(boundaries[boundary_index + 1], lines, total_end_ms)
                    - _boundary_time_ms(boundaries[boundary_index - 1], lines, total_end_ms)
                )
                - TARGET_SEGMENT_DURATION_MS
            ),
        )
        boundaries.pop(best_option)
    return boundaries


def _split_long_segments(
    boundaries: list[int],
    lines: list[ParsedTranscriptLine],
    total_end_ms: int,
) -> list[int]:
    result = [boundaries[0]]
    for end_index in boundaries[1:]:
        start_index = result[-1]
        while (
            _boundary_time_ms(end_index, lines, total_end_ms)
            - _boundary_time_ms(start_index, lines, total_end_ms)
            > MAX_SEGMENT_DURATION_MS
        ):
            start_ms = _boundary_time_ms(start_index, lines, total_end_ms)
            target_ms = start_ms + MAX_SEGMENT_DURATION_MS
            candidates = [
                index
                for index in range(start_index + 1, end_index)
                if _boundary_time_ms(index, lines, total_end_ms) - start_ms <= MAX_SEGMENT_DURATION_MS
            ]
            if not candidates:
                break

            candidates_with_tail = [
                index
                for index in candidates
                if _boundary_time_ms(end_index, lines, total_end_ms)
                - _boundary_time_ms(index, lines, total_end_ms)
                >= MIN_SEGMENT_DURATION_MS
            ]
            candidates = candidates_with_tail or candidates
            split_index = min(
                candidates,
                key=lambda index: (
                    abs(_boundary_time_ms(index, lines, total_end_ms) - target_ms),
                    -index,
                ),
            )
            result.append(split_index)
            start_index = split_index
        result.append(end_index)
    return result


def _node_for_boundary(
    start_index: int,
    node_by_boundary: dict[int, LogicNode],
) -> LogicNode | None:
    eligible = [index for index in node_by_boundary if index <= start_index]
    if not eligible:
        return next(iter(node_by_boundary.values()), None)
    return node_by_boundary[max(eligible)]


def _make_segment(
    content_id: str,
    analysis_version: str,
    sequence: int,
    start_index: int,
    end_index: int,
    lines: list[ParsedTranscriptLine],
    node: LogicNode | None,
    corpus_items: list[CorpusItem],
    total_end_ms: int | None,
    *,
    title: str | None = None,
    summary: str | None = None,
) -> BlueprintSegment:
    source_text = " ".join(line.text for line in lines[start_index:end_index]).strip()
    word_count = len(re.findall(r"[A-Za-z0-9']+", source_text))
    start_ms = _boundary_time_ms(start_index, lines, total_end_ms)
    end_ms = _boundary_time_ms(end_index, lines, total_end_ms)
    duration_ms = end_ms - start_ms if start_ms is not None and end_ms is not None else None
    phonology_tags = _segment_phonology_tags(source_text, corpus_items)
    difficulty = _segment_difficulty(lines[start_index:end_index], word_count)
    node_title = node.title if node is not None else None
    node_summary = node.subtitle if node is not None else None
    return BlueprintSegment(
        id=str(uuid5(NAMESPACE_URL, f"segment:{content_id}:{analysis_version}:{sequence - 1}")),
        sequence=sequence,
        title=title or node_title or f"Practice segment {sequence}",
        summary=summary or node_summary or "A transcript segment selected for focused shadowing.",
        logic_node_id=node.id if node is not None else None,
        timestamp_ms=_timestamp_ms(node.time) if node is not None else start_ms,
        start_ms=start_ms,
        end_ms=end_ms,
        duration_ms=duration_ms,
        transcript_start_index=start_index,
        transcript_end_index=end_index,
        source_text=source_text or None,
        quote=_segment_quote(source_text),
        word_count=word_count,
        phonology_tags=phonology_tags,
        difficulty=difficulty,
    )


def _boundary_time_ms(
    index: int,
    lines: list[ParsedTranscriptLine],
    total_end_ms: int | None,
) -> int | None:
    if index == 0:
        return 0 if total_end_ms is not None else None
    if index >= len(lines):
        return total_end_ms
    for line in lines[index:]:
        if line.start_ms is not None:
            return line.start_ms
        seconds = timestamp_seconds(line.time)
        if seconds is not None:
            return round(seconds * 1000)
    return total_end_ms


def _estimated_transcript_end_ms(
    lines: list[ParsedTranscriptLine],
    timed_indexes: list[int],
) -> int:
    last_index = timed_indexes[-1]
    if lines[last_index].end_ms is not None:
        return lines[last_index].end_ms
    last_start_ms = round(timestamp_seconds(lines[last_index].time) * 1000)
    words = len(re.findall(r"[A-Za-z0-9']+", lines[last_index].text))
    tail_ms = max(ESTIMATED_TAIL_MIN_MS, min(ESTIMATED_TAIL_MAX_MS, words * 250))
    return last_start_ms + tail_ms


def _segment_quote(source_text: str) -> str | None:
    if not source_text:
        return None
    if len(source_text) <= 220:
        return source_text
    return f"{source_text[:217].rstrip()}..."


def _segment_phonology_tags(
    source_text: str,
    corpus_items: list[CorpusItem],
) -> list[str]:
    normalized_source = _normalized_evidence_text(source_text)
    tags: set[str] = set()
    for item in corpus_items:
        if not item.phonology_note or not item.source_text:
            continue
        if _normalized_evidence_text(item.source_text) not in normalized_source:
            continue
        note = item.phonology_note.casefold()
        tags.update(tag for hint, tag in PHONOLOGY_TAG_HINTS if hint in note)
    return [tag for _, tag in PHONOLOGY_TAG_HINTS if tag in tags]


def _segment_difficulty(
    lines: list[ParsedTranscriptLine],
    word_count: int,
) -> str:
    longest_line = max(
        (len(re.findall(r"[A-Za-z0-9']+", line.text)) for line in lines),
        default=0,
    )
    if word_count > 300 or longest_line > 36:
        return "dense"
    if word_count > 180 or longest_line > 24:
        return "medium"
    return "easy"


def _mark_recommended_segment(segments: list[BlueprintSegment]) -> list[BlueprintSegment]:
    if not segments:
        return segments
    difficulty_rank = {"easy": 0, "medium": 1, "dense": 2}
    recommended_index = min(
        range(len(segments)),
        key=lambda index: (
            difficulty_rank.get(segments[index].difficulty, 1),
            abs((segments[index].duration_ms or TARGET_SEGMENT_DURATION_MS) - TARGET_SEGMENT_DURATION_MS),
            -len(segments[index].phonology_tags),
            index,
        ),
    )
    return [
        segment.model_copy(update={"recommended": index == recommended_index})
        for index, segment in enumerate(segments)
    ]


def _extract_corpus_items(lines: list[ParsedTranscriptLine]) -> list[CorpusItem]:
    items: list[CorpusItem] = []
    transcript = "\n".join(line.text for line in lines)
    lowered = transcript.casefold()

    for pattern in CHUNK_PATTERNS:
        if pattern.phrase.casefold() not in lowered:
            continue
        source_line = next(line for line in lines if pattern.phrase.casefold() in line.text.casefold())
        items.append(
            CorpusItem(
                id=f"chunk-{len(items) + 1}",
                kind="chunk",
                text=f'"{pattern.phrase}" - {pattern.description}',
                tags=list(pattern.tags),
                meta=f"{source_line.time} - click + to save",
            )
        )

    for regex, template, tags in STRUCTURE_PATTERNS:
        match = regex.search(transcript)
        if not match:
            continue
        source_line = next((line for line in lines if regex.search(line.text)), lines[0])
        items.append(
            CorpusItem(
                id=f"structure-{len(items) + 1}",
                kind="structure",
                text=template,
                tags=list(tags),
                meta=f"{source_line.time} - syntactic structure",
            )
        )
    return items[:12]


def _annotate_transcript(lines: list[ParsedTranscriptLine]) -> list[TranscriptLine]:
    count = min(5, len(lines))
    logic_indexes = {
        round(index * (len(lines) - 1) / max(count - 1, 1)): index + 1
        for index in range(count)
    }
    return [
        TranscriptLine(
            id=f"logic-{logic_indexes[index]}" if index in logic_indexes else None,
            time=line.time,
            parts=_highlight_parts(line.text),
        )
        for index, line in enumerate(lines)
    ]


def _highlight_parts(text: str) -> list[str | HighlightedTranscriptPart]:
    matches: list[tuple[int, int, LanguagePattern]] = []
    lowered = text.casefold()
    for pattern in CHUNK_PATTERNS:
        start = lowered.find(pattern.phrase.casefold())
        if start >= 0:
            matches.append((start, start + len(pattern.phrase), pattern))
    matches.sort(key=lambda item: item[0])

    parts: list[str | HighlightedTranscriptPart] = []
    cursor = 0
    for start, end, pattern in matches:
        if start < cursor:
            continue
        if start > cursor:
            parts.append(text[cursor:start])
        parts.append(HighlightedTranscriptPart(text=text[start:end], tag=pattern.tags[0], kind="chunk"))
        cursor = end
    if cursor < len(text):
        parts.append(text[cursor:])
    return parts or [text]


def _highlight_corpus_parts(
    text: str,
    corpus_items: list[CorpusItem],
) -> list[str | HighlightedTranscriptPart]:
    matches: list[tuple[int, int, str, str]] = []
    lowered = text.casefold()
    for item in corpus_items:
        phrase = item.source_text or _candidate_phrase(item.text)
        match = _find_candidate_match(lowered, phrase)
        if match is None:
            continue
        start, end = match
        tag = next(iter(_valid_tags(item.tags)), "discourse")
        matches.append((start, end, item.kind, tag))
    matches.sort(key=lambda item: (item[0], -item[1]))

    parts: list[str | HighlightedTranscriptPart] = []
    cursor = 0
    for start, end, kind, tag in matches:
        if start < cursor:
            continue
        if start > cursor:
            parts.append(text[cursor:start])
        parts.append(HighlightedTranscriptPart(text=text[start:end], tag=tag, kind=kind))
        cursor = end
    if cursor < len(text):
        parts.append(text[cursor:])
    return parts or [text]


def _select_corpus_items(
    corpus_items: list[CorpusItem],
    learner_level: LearnerLevel | None,
    limit: int,
) -> list[CorpusItem]:
    ranked = sorted(
        corpus_items,
        key=lambda item: -_corpus_rank(item, learner_level),
    )
    if len(ranked) <= limit:
        return ranked

    idiom_quota = max(1, limit // 6)
    structure_quota = max(2, limit // 3)
    chunk_quota = max(1, limit - idiom_quota - structure_quota)
    selected_ids = {
        item.id
        for item in [
            *[item for item in ranked if item.kind == "chunk"][:chunk_quota],
            *[item for item in ranked if item.kind == "idiom"][:idiom_quota],
            *[item for item in ranked if item.kind == "structure"][:structure_quota],
        ]
    }
    for item in ranked:
        if len(selected_ids) >= limit:
            break
        selected_ids.add(item.id)
    return [item for item in ranked if item.id in selected_ids]


def _evidenced_analysis_items(
    corpus_items: list[AnalysisCorpusItem],
    lines: list[ParsedTranscriptLine],
) -> list[AnalysisCorpusItem]:
    transcript = _normalized_evidence_text(" ".join(line.text for line in lines))
    accepted: list[AnalysisCorpusItem] = []
    seen: set[tuple[str, str]] = set()
    for item in corpus_items:
        source_text = _normalized_evidence_text(item.source_text)
        dedupe_key = (item.kind, _normalized_evidence_text(item.text))
        if (
            not source_text
            or source_text not in transcript
            or dedupe_key in seen
            or not _is_useful_analysis_item(item)
        ):
            continue
        seen.add(dedupe_key)
        accepted.append(item)
    return accepted


def _is_useful_analysis_item(item: AnalysisCorpusItem) -> bool:
    if item.kind == "structure":
        return re.search(r"\[[a-z][a-z0-9 _-]*\]", item.text, re.I) is not None

    words = re.findall(r"[a-z0-9']+", item.text.casefold())
    filler_only = {"uh", "um", "well", "like", "you", "know", "i", "think"}
    quality = item.naturalness_score + item.transferability_score + item.learning_value_score
    return 2 <= len(words) <= 14 and not set(words).issubset(filler_only) and quality >= 10


def _corpus_rank(item: CorpusItem, learner_level: LearnerLevel | None) -> int:
    quality = (
        (item.learning_value_score or 3) * 2
        + (item.naturalness_score or 3)
        + (item.transferability_score or 3)
    )
    if learner_level is None or item.level is None:
        return quality

    delta = LEVEL_ORDER[item.level] - LEVEL_ORDER[learner_level]
    level_bonus = {
        0: 8,
        1: 6,
        -1: 5,
        2: 2,
        -2: 2,
    }.get(delta, 0)
    return quality + level_bonus


def _transcript_text(line: TranscriptLine) -> str:
    return "".join(part if isinstance(part, str) else part.text for part in line.parts)


def _normalized_evidence_text(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9']+", value.casefold()))


def _candidate_phrase(value: str) -> str:
    quoted = re.match(r'^["“\'](.+?)["”\']\s*(?:[-–—]|$)', value)
    if quoted:
        return quoted.group(1).strip()
    return re.split(r"\s+[-–—]\s+", value, maxsplit=1)[0].strip('"“”\' ')


def _find_candidate_match(lowered_text: str, phrase: str) -> tuple[int, int] | None:
    lowered_phrase = phrase.casefold()
    start = lowered_text.find(lowered_phrase)
    if start >= 0:
        return start, start + len(phrase)

    words = re.findall(r"[a-z0-9']+", lowered_phrase)
    for length in range(len(words) - 1, 2, -1):
        for start_word in range(0, len(words) - length + 1):
            fragment = " ".join(words[start_word : start_word + length])
            start = lowered_text.find(fragment)
            if start >= 0:
                return start, start + len(fragment)
    return None


def _valid_tags(tags: list[str]) -> list[str]:
    return [tag for tag in tags if tag in VALID_TAGS]


def _logic_id_for_time(timestamp: str, nodes: list[LogicNode]) -> str | None:
    return next((node.id for node in nodes if node.time == timestamp), None)


def _timestamp_ms(timestamp: str | None) -> int | None:
    if not timestamp:
        return None
    seconds = timestamp_seconds(timestamp)
    return round(seconds * 1000) if seconds is not None else None
