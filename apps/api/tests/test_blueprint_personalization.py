import pytest
from pydantic import ValidationError

from app.schemas.analysis import (
    AnalysisCorpusItem,
    AnalysisLogicNode,
    BlueprintAnalysis,
)
from app.schemas.blueprint import Blueprint, CorpusItem, LogicNode, TranscriptLine
from app.schemas.content import ContentKind, ContentResolveResponse
from app.services.blueprint_service import create_blueprint_from_analysis, personalize_blueprint


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
