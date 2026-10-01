import pytest
from pydantic import ValidationError

from app.schemas.analysis import (
    AnalysisCorpusItem,
    AnalysisLogicNode,
    BlueprintAnalysis,
)
from app.schemas.blueprint import Blueprint, BlueprintSegment, CorpusItem, LogicNode, TranscriptLine
from app.schemas.content import ContentKind, ContentResolveResponse
from app.services.blueprint_service import create_blueprint_from_analysis, personalize_blueprint


def test_segment_contract_accepts_a_complete_playable_range() -> None:
    segment = BlueprintSegment(
        id="segment-1",
        sequence=1,
        title="Opening context",
        summary="The speaker establishes the context.",
        logic_node_id="logic-1",
        timestamp_ms=0,
        start_ms=0,
        end_ms=105_000,
        duration_ms=105_000,
        transcript_start_index=0,
        transcript_end_index=4,
        source_text="The speaker establishes the context.",
        quote="The speaker establishes the context.",
        word_count=6,
        phonology_tags=["wk", "lk"],
        difficulty="easy",
        recommended=True,
    )

    assert segment.duration_ms == segment.end_ms - segment.start_ms
    assert segment.transcript_end_index > segment.transcript_start_index


def test_segment_contract_rejects_incomplete_or_inconsistent_ranges() -> None:
    with pytest.raises(ValidationError, match="start_ms and end_ms"):
        BlueprintSegment(
            id="segment-1",
            title="Incomplete",
            summary="Missing end time.",
            start_ms=0,
        )

    with pytest.raises(ValidationError, match="duration_ms"):
        BlueprintSegment(
            id="segment-1",
            title="Inconsistent",
            summary="Duration does not match the range.",
            start_ms=0,
            end_ms=10_000,
            duration_ms=9_000,
        )


def test_legacy_segment_without_new_ranges_remains_readable() -> None:
    segment = BlueprintSegment(
        id="segment-legacy",
        title="Legacy segment",
        summary="A segment created before the Stage 2 contract.",
        timestamp_ms=12_000,
    )

    assert segment.start_ms is None
    assert segment.end_ms is None
    assert segment.phonology_tags == []


def test_personalize_backfills_playable_segments_for_legacy_blueprints() -> None:
    blueprint = Blueprint(
        id="legacy-blueprint",
        content_id="legacy-content",
        analysis_version="mvp-v9",
        title="Legacy video",
        source_url="https://youtube.com/watch?v=legacy",
        summary="A legacy blueprint without persisted segment ranges.",
        logic_flow=[LogicNode(id="logic-1", title="Opening", subtitle="The opening.", time="0:01")],
        chapters=["Opening"],
        transcript=[
            TranscriptLine(time="0:01", parts=["The opening sentence."]),
            TranscriptLine(time="0:50", parts=["The second sentence continues the idea."]),
            TranscriptLine(time="1:45", parts=["The final sentence closes the segment."]),
        ],
        corpus_items=[],
        key_points=["The opening is clear."],
        scenario_suggestions=["Explain the opening"],
        segments=[],
    )

    personalized = personalize_blueprint(blueprint, learner_level=None)

    assert len(personalized.segments) == 1
    assert personalized.segments[0].start_ms == 0
    assert personalized.segments[0].end_ms == 107_000
    assert personalized.segments[0].duration_ms == 107_000


def test_segments_cover_a_long_transcript_and_split_at_sentence_boundaries() -> None:
    content = ContentResolveResponse(
        content_id="content-segmented",
        kind=ContentKind.youtube,
        normalized_key="youtube:segmented",
        title="Segmented video",
    )
    analysis = BlueprintAnalysis(
        summary="A long transcript for segment generation.",
        chapters=["Opening"],
        logic_flow=[AnalysisLogicNode(title="Opening", subtitle="The speaker starts.", timestamp="0:00")],
        corpus_items=[],
        key_points=["Long content is split into playable units."],
        scenario_suggestions=["Summarize the content"],
    )
    formatted = "\n".join(
        f"{index // 60}:{index % 60:02d}\tSentence {index}."
        for index in range(0, 901, 30)
    )

    blueprint = create_blueprint_from_analysis(
        content,
        formatted,
        analysis,
        formatted_transcript_text=formatted,
    )

    segments = blueprint.segments
    assert len(segments) == 4
    assert segments[0].start_ms == 0
    assert segments[-1].end_ms == 902_000
    assert all(segment.duration_ms <= 300_000 for segment in segments)
    assert all(
        current.end_ms == following.start_ms
        for current, following in zip(segments, segments[1:])
    )
    assert all(
        segment.transcript_start_index < segment.transcript_end_index
        for segment in segments
    )
    assert segments[1].title.endswith("Part 2")


def test_short_logic_ranges_are_merged_without_losing_transcript_coverage() -> None:
    content = ContentResolveResponse(
        content_id="content-short-ranges",
        kind=ContentKind.youtube,
        normalized_key="youtube:short-ranges",
        title="Short ranges",
    )
    analysis = BlueprintAnalysis(
        summary="Short logic ranges should be merged.",
        chapters=["Opening", "Development", "Takeaway"],
        logic_flow=[
            AnalysisLogicNode(title="Opening", subtitle="The opening.", timestamp="0:00"),
            AnalysisLogicNode(title="Development", subtitle="A short development.", timestamp="0:20"),
            AnalysisLogicNode(title="Takeaway", subtitle="The takeaway.", timestamp="1:40"),
        ],
        corpus_items=[],
        key_points=["Short segments are not useful for shadowing."],
        scenario_suggestions=["Explain the takeaway"],
    )
    formatted = (
        "0:00\tThe opening sentence.\n"
        "0:20\tA short development sentence.\n"
        "1:40\tThe takeaway sentence.\n"
        "3:00\tA final supporting sentence."
    )

    blueprint = create_blueprint_from_analysis(
        content,
        formatted,
        analysis,
        formatted_transcript_text=formatted,
    )

    assert len(blueprint.segments) == 2
    assert blueprint.segments[0].start_ms == 0
    assert blueprint.segments[0].end_ms == blueprint.segments[1].start_ms
    assert blueprint.segments[0].transcript_end_index == 2
    assert blueprint.segments[1].transcript_start_index == 2


def test_segments_without_timestamps_remain_readable_but_not_playable() -> None:
    content = ContentResolveResponse(
        content_id="content-untimed-segments",
        kind=ContentKind.pasted_text,
        normalized_key="pasted:untimed-segments",
        title="Untimed text",
    )
    analysis = BlueprintAnalysis(
        summary="An untimed transcript.",
        chapters=["Opening"],
        logic_flow=[AnalysisLogicNode(title="Opening", subtitle="The text starts.")],
        corpus_items=[],
        key_points=["Untimed content has no playback range."],
        scenario_suggestions=["Read the text"],
    )

    blueprint = create_blueprint_from_analysis(
        content,
        "A sentence without a timestamp.",
        analysis,
        formatted_transcript_text="A sentence without a timestamp.",
    )

    assert len(blueprint.segments) == 1
    assert blueprint.segments[0].start_ms is None
    assert blueprint.segments[0].end_ms is None
    assert blueprint.segments[0].transcript_start_index == 0
    assert blueprint.segments[0].transcript_end_index == 1


def test_segment_metadata_uses_evidenced_phonology_notes() -> None:
    content = ContentResolveResponse(
        content_id="content-segment-metadata",
        kind=ContentKind.youtube,
        normalized_key="youtube:segment-metadata",
        title="Segment metadata",
    )
    analysis = BlueprintAnalysis(
        summary="Metadata follows transcript evidence.",
        chapters=["Opening"],
        logic_flow=[AnalysisLogicNode(title="Opening", subtitle="The speaker concedes.", timestamp="0:00")],
        corpus_items=[
            AnalysisCorpusItem(
                kind="chunk",
                text="to be fair",
                source_text="to be fair",
                meaning="concedes a point",
                usage_note="Use before a counterpoint.",
                tags=["acknowledging"],
                pattern_family=None,
                timestamp="0:00",
                level="B1",
                register="neutral",
                scenario_tags=["discussion"],
                phonology_note="Weak form and linking are useful here.",
                naturalness_score=5,
                transferability_score=5,
                learning_value_score=5,
            )
        ],
        key_points=["The speaker concedes a point."],
        scenario_suggestions=["Acknowledge a concern"],
    )
    formatted = "0:00\tTo be fair, this is a useful example."

    blueprint = create_blueprint_from_analysis(
        content,
        formatted,
        analysis,
        formatted_transcript_text=formatted,
    )

    segment = blueprint.segments[0]
    assert segment.word_count == 8
    assert segment.quote == "To be fair, this is a useful example."
    assert segment.phonology_tags == ["lk", "wk"]
    assert segment.recommended is True


def test_chunk_analysis_requires_exact_source_text() -> None:
    with pytest.raises(ValidationError, match="exactly match"):
        AnalysisCorpusItem(
            kind="chunk",
            text="to be entirely fair",
            source_text="to be fair",
            meaning="concedes a point",
            usage_note="Use before presenting a different view.",
            tags=["acknowledging"],
            pattern_family=None,
            timestamp="0:01",
            level="B1",
            register="professional",
            scenario_tags=["workplace", "disagreement"],
            phonology_note=None,
            naturalness_score=5,
            transferability_score=5,
            learning_value_score=5,
        )


def test_analysis_discards_unsupported_and_duplicate_candidates() -> None:
    content = ContentResolveResponse(
        content_id="content-evidence",
        kind=ContentKind.youtube,
        normalized_key="youtube:evidence",
        title="Evidence",
    )
    analysis = BlueprintAnalysis(
        summary="A short evidence test.",
        chapters=["Evidence"],
        logic_flow=[AnalysisLogicNode(title="Claim", subtitle="A claim is made.", timestamp="0:01")],
        corpus_items=[
            _analysis_item("chunk", "to be fair", "to be fair", "B1"),
            _analysis_item("chunk", "to be fair", "to be fair", "B1"),
            _analysis_item("structure", "It comes down to [factor]", "it comes down to timing", "B2"),
        ],
        key_points=["Only transcript evidence is retained."],
        scenario_suggestions=["Concede a point"],
    )

    blueprint = create_blueprint_from_analysis(
        content,
        "0:01\tTo be fair, this is the only expression in the transcript.",
        analysis,
    )

    assert [item.source_text for item in blueprint.corpus_items] == ["to be fair"]
    assert blueprint.segments[0].sequence == 1
    assert blueprint.segments[0].logic_node_id == blueprint.logic_flow[0].id


def test_idiom_keeps_canonical_text_and_exact_source_evidence() -> None:
    content = ContentResolveResponse(
        content_id="content-idiom",
        kind=ContentKind.youtube,
        normalized_key="youtube:idiom",
        title="Idiom evidence",
    )
    analysis = BlueprintAnalysis(
        summary="The speaker describes increasing commitment.",
        chapters=["Commitment"],
        logic_flow=[
            AnalysisLogicNode(
                title="Doubling down on the plan",
                subtitle="The speaker increases commitment.",
                timestamp="0:10",
            )
        ],
        corpus_items=[
            _analysis_item("idiom", "double down on", "doubled down on", "B2")
        ],
        key_points=["The plan receives more support."],
        scenario_suggestions=["Discuss a strategic commitment"],
    )

    blueprint = create_blueprint_from_analysis(
        content,
        "0:10\tThey doubled down on the original plan.",
        analysis,
    )

    assert len(blueprint.corpus_items) == 1
    assert blueprint.corpus_items[0].kind == "idiom"
    assert blueprint.corpus_items[0].source_text == "doubled down on"
    assert blueprint.corpus_items[0].text.startswith('"double down on"')


def test_personalization_ranks_for_level_and_keeps_kind_balance() -> None:
    corpus_items = [
        _blueprint_item("chunk-b1", "chunk", "B1"),
        _blueprint_item("chunk-b2", "chunk", "B2"),
        _blueprint_item("chunk-c1", "chunk", "C1"),
        _blueprint_item("structure-b1", "structure", "B1"),
        _blueprint_item("structure-b2", "structure", "B2"),
        _blueprint_item("structure-c1", "structure", "C1"),
    ]
    blueprint = Blueprint(
        id="blueprint-levels",
        content_id="content-levels",
        title="Levels",
        summary="Level ranking",
        logic_flow=[LogicNode(id="logic-1", title="Levels", subtitle="Compare levels")],
        transcript=[TranscriptLine(time="0:01", parts=["No candidate text here."])],
        corpus_items=corpus_items,
        key_points=["Rank by level"],
        scenario_suggestions=["Choose an expression"],
    )

    b1 = personalize_blueprint(blueprint, "B1", corpus_limit=4)
    c1 = personalize_blueprint(blueprint, "C1", corpus_limit=4)

    assert {item.level for item in b1.corpus_items} == {"B1", "B2"}
    assert {item.level for item in c1.corpus_items} == {"B2", "C1"}
    assert {item.kind for item in b1.corpus_items} == {"chunk", "structure"}


def test_personalization_reserves_space_for_idioms() -> None:
    corpus_items = [
        *[_blueprint_item(f"chunk-{index}", "chunk", "B2") for index in range(8)],
        *[_blueprint_item(f"idiom-{index}", "idiom", "B2") for index in range(3)],
        *[_blueprint_item(f"structure-{index}", "structure", "B2") for index in range(5)],
    ]
    blueprint = Blueprint(
        id="blueprint-kinds",
        content_id="content-kinds",
        title="Kinds",
        summary="Kind balancing",
        logic_flow=[LogicNode(id="logic-1", title="Kinds", subtitle="Balance kinds")],
        corpus_items=corpus_items,
        key_points=["Keep all three kinds visible."],
        scenario_suggestions=["Compare expressions"],
    )

    selected = personalize_blueprint(blueprint, "B2", corpus_limit=12)

    assert {item.kind for item in selected.corpus_items} == {"chunk", "idiom", "structure"}
    assert sum(item.kind == "idiom" for item in selected.corpus_items) >= 2


def test_long_caption_transcript_is_merged_and_keeps_late_evidence() -> None:
    content = ContentResolveResponse(
        content_id="content-long-captions",
        kind=ContentKind.youtube,
        normalized_key="youtube:long-captions",
        title="Long captions",
    )
    lines = []
    for index in range(299):
        minutes, seconds = divmod(index, 60)
        lines.append(f"{minutes}:{seconds:02d}\tthis is caption fragment number {index}")
    lines.append("4:59\tit comes down to deliberate practice")
    analysis = BlueprintAnalysis(
        summary="A long caption-merging test.",
        chapters=["Practice"],
        logic_flow=[AnalysisLogicNode(title="Practice", subtitle="Practice matters.", timestamp="4:59")],
        corpus_items=[
            _analysis_item(
                "structure",
                "It comes down to [factor]",
                "It comes down to deliberate practice.",
                "B2",
            )
        ],
        key_points=["Late transcript evidence must survive."],
        scenario_suggestions=["Explain a deciding factor"],
    )

    blueprint = create_blueprint_from_analysis(content, "\n".join(lines), analysis)

    assert [item.kind for item in blueprint.corpus_items] == ["structure"]
    assert len(blueprint.transcript) < len(lines)
    rendered_lines = [
        "".join(part if isinstance(part, str) else part.text for part in line.parts)
        for line in blueprint.transcript
    ]
    assert rendered_lines[0].startswith("This")
    assert all(line.endswith((".", "!", "?")) for line in rendered_lines)


def test_local_formatting_rebuilds_transcript_without_repeating_text() -> None:
    content = ContentResolveResponse(
        content_id="content-punctuated-captions",
        kind=ContentKind.youtube,
        normalized_key="youtube:punctuated-captions",
        title="Punctuated captions",
    )
    analysis = BlueprintAnalysis(
        summary="A punctuation test.",
        chapters=["Opening"],
        logic_flow=[AnalysisLogicNode(title="Opening", subtitle="Two complete thoughts.", timestamp="0:01")],
        corpus_items=[_analysis_item("chunk", "to be fair", "to be fair", "B1")],
        key_points=["Sentence boundaries are local and evidence-checked."],
        scenario_suggestions=["Read a punctuated transcript"],
    )
    transcript = (
        "0:01\tto be fair this starts\n"
        "0:03\tas several caption fragments\n"
        "0:05\tthen the speaker completes\n"
        "0:07\tanother thought"
    )

    formatted = (
        "0:01\tTo be fair, this starts as several caption fragments.\n"
        "0:05\tThen the speaker completes another thought!"
    )
    blueprint = create_blueprint_from_analysis(
        content,
        transcript,
        analysis,
        formatted_transcript_text=formatted,
    )

    rendered_lines = [
        "".join(part if isinstance(part, str) else part.text for part in line.parts)
        for line in blueprint.transcript
    ]
    assert rendered_lines == [
        "To be fair, this starts as several caption fragments.",
        "Then the speaker completes another thought!",
    ]
    assert [line.time for line in blueprint.transcript] == ["0:01", "0:05"]


def test_local_formatter_groups_sentences_with_the_same_caption_timestamp() -> None:
    content = ContentResolveResponse(
        content_id="content-inline-boundary",
        kind=ContentKind.youtube,
        normalized_key="youtube:inline-boundary",
        title="Inline boundary",
    )
    analysis = BlueprintAnalysis(
        summary="An inline boundary test.",
        chapters=["Opening"],
        logic_flow=[AnalysisLogicNode(title="Opening", subtitle="Two thoughts.", timestamp="0:01")],
        key_points=["Caption rows do not define sentence boundaries."],
        scenario_suggestions=["Read a punctuated transcript"],
    )
    transcript = "0:01\tso let's begin now here comes another\n0:03\tcomplete thought at last"

    formatted = "0:01\tSo let's begin now.\n0:01\tHere comes another complete thought at last!"
    blueprint = create_blueprint_from_analysis(
        content,
        transcript,
        analysis,
        formatted_transcript_text=formatted,
    )

    rendered_lines = [
        "".join(part if isinstance(part, str) else part.text for part in line.parts)
        for line in blueprint.transcript
    ]
    assert rendered_lines == [
        "So let's begin now. Here comes another complete thought at last!"
    ]
    assert [line.time for line in blueprint.transcript] == ["0:01"]


def test_analysis_evidence_uses_the_cleaned_display_transcript() -> None:
    content = ContentResolveResponse(
        content_id="content-cleaned-evidence",
        kind=ContentKind.youtube,
        normalized_key="youtube:cleaned-evidence",
        title="Cleaned evidence",
    )
    analysis = BlueprintAnalysis(
        summary="A filler-removal evidence test.",
        chapters=["Claim"],
        logic_flow=[
            AnalysisLogicNode(
                title="Claim",
                subtitle="The speaker states a view.",
                timestamp="0:01",
            )
        ],
        corpus_items=[_analysis_item("chunk", "we should", "we should", "B1")],
        key_points=["Cleaned evidence remains selectable."],
        scenario_suggestions=["State an opinion"],
    )

    blueprint = create_blueprint_from_analysis(
        content,
        "0:01\tWe um should discuss this.",
        analysis,
        formatted_transcript_text="0:01\tWe should discuss this.",
    )

    assert [item.source_text for item in blueprint.corpus_items] == ["we should"]
    highlighted = [
        part
        for part in blueprint.transcript[0].parts
        if not isinstance(part, str)
    ]
    assert [part.text for part in highlighted] == ["We should"]


def test_missing_formatted_transcript_falls_back_to_local_merging() -> None:
    content = ContentResolveResponse(
        content_id="content-invalid-boundary",
        kind=ContentKind.youtube,
        normalized_key="youtube:invalid-boundary",
        title="Invalid boundary",
    )
    analysis = BlueprintAnalysis(
        summary="A boundary validation test.",
        chapters=["Opening"],
        logic_flow=[AnalysisLogicNode(title="Opening", subtitle="One thought.", timestamp="0:01")],
        key_points=["Unknown anchors are rejected."],
        scenario_suggestions=["Read a punctuated transcript"],
    )
    transcript = "0:01\tthis starts here\n0:03\tand finishes here"

    blueprint = create_blueprint_from_analysis(content, transcript, analysis)

    rendered = "".join(
        part if isinstance(part, str) else part.text
        for part in blueprint.transcript[0].parts
    )
    assert rendered == "This starts here and finishes here."


def _analysis_item(kind: str, text: str, source_text: str, level: str) -> AnalysisCorpusItem:
    return AnalysisCorpusItem(
        kind=kind,
        text=text,
        source_text=source_text,
        meaning="useful expression",
        usage_note="Use this expression in a new context.",
        tags=["framing"],
        pattern_family="framed-explanation" if kind == "structure" else None,
        timestamp="0:01",
        level=level,
        register="neutral",
        scenario_tags=["explanation"],
        phonology_note=None,
        naturalness_score=4,
        transferability_score=4,
        learning_value_score=4,
    )


def _blueprint_item(item_id: str, kind: str, level: str) -> CorpusItem:
    return CorpusItem(
        id=item_id,
        kind=kind,
        text=item_id,
        tags=["framing"],
        meta="0:01 - click + to save",
        level=level,
        naturalness_score=3,
        transferability_score=3,
        learning_value_score=3,
    )
