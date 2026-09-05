import re
from dataclasses import dataclass
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
from app.services import store
from app.services.transcript_formatter import (
    ParsedTranscriptLine,
    merge_transcript_fragments,
    parse_transcript,
)


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
    selected_items = _select_corpus_items(blueprint.corpus_items, learner_level, corpus_limit)
    transcript = [
        TranscriptLine(
            id=line.id,
            time=line.time,
            parts=_highlight_corpus_parts(_transcript_text(line), selected_items),
        )
        for line in blueprint.transcript
    ]
    return blueprint.model_copy(
        update={
            "corpus_items": selected_items,
            "transcript": transcript,
        }
    )


def create_blueprint(content: ContentResolveResponse, transcript_text: str) -> Blueprint:
    parsed_lines = parse_transcript(transcript_text)
    readable_lines = merge_transcript_fragments(parsed_lines)
    corpus_items = _extract_corpus_items(parsed_lines)
    transcript = _annotate_transcript(readable_lines)
    logic_flow = _build_logic_flow(readable_lines)
    title = content.title or "Untitled YouTube video"

    blueprint = Blueprint(
        id=f"blueprint_{content.content_id}",
        content_id=content.content_id,
        analysis_version=get_settings().analysis_version,
        title=title,
        source_url=content.source_url,
        summary=_build_summary(title, parsed_lines),
        logic_flow=logic_flow,
        chapters=[node.title for node in logic_flow],
        transcript=transcript,
        corpus_items=corpus_items,
        key_points=[node.subtitle for node in logic_flow],
        scenario_suggestions=["Explain the main idea", "Respond with a contrasting view", "Summarize the takeaway"],
        segments=[
            BlueprintSegment(
                id=f"segment-{index + 1}",
                title=node.title,
                summary=node.subtitle,
                timestamp_ms=_timestamp_ms(node.time),
            )
            for index, node in enumerate(logic_flow)
        ],
    )
    store.blueprints[content.content_id] = blueprint
    return blueprint


def create_blueprint_from_analysis(
    content: ContentResolveResponse,
    transcript_text: str,
    analysis: BlueprintAnalysis,
    analysis_version: str | None = None,
    formatted_transcript_text: str | None = None,
) -> Blueprint:
    analysis_version = analysis_version or get_settings().analysis_version
    parsed_lines = parse_transcript(transcript_text)
    readable_lines = (
        parse_transcript(formatted_transcript_text)
        if formatted_transcript_text
        else merge_transcript_fragments(parsed_lines)
    )
    analyzed_corpus_items = _evidenced_analysis_items(analysis.corpus_items, parsed_lines)
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
            id=_logic_id_for_time(line.time, logic_flow),
            time=line.time,
            parts=_highlight_corpus_parts(line.text, corpus_items),
        )
        for line in readable_lines
    ]
    blueprint = Blueprint(
        id=str(uuid5(NAMESPACE_URL, f"blueprint:{content.content_id}:{analysis_version}")),
        content_id=content.content_id,
        analysis_version=analysis_version,
        title=content.title or "Untitled YouTube video",
        source_url=content.source_url,
        summary=analysis.summary,
        logic_flow=logic_flow,
        chapters=analysis.chapters,
        transcript=transcript,
        corpus_items=corpus_items,
        key_points=analysis.key_points,
        scenario_suggestions=analysis.scenario_suggestions,
        segments=[
            BlueprintSegment(
                id=str(uuid5(NAMESPACE_URL, f"segment:{content.content_id}:{analysis_version}:{index}")),
                title=node.title,
                summary=node.subtitle,
                timestamp_ms=_timestamp_ms(node.time),
            )
            for index, node in enumerate(logic_flow)
        ],
    )
    return blueprint


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
    components = [int(component) for component in timestamp.split(":")]
    seconds = components[-1] + (components[-2] * 60)
    if len(components) == 3:
        seconds += components[0] * 3600
    return seconds * 1000
