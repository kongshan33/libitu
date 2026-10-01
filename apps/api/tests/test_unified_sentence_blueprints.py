from app.schemas.analysis import AnalysisLogicNode, BlueprintAnalysis
from app.schemas.blueprint import Blueprint, CorpusItem, LogicNode, TranscriptLine
from app.schemas.content import ContentKind, ContentResolveResponse
from app.services import blueprint_service
from app.services.sentence_formatter import format_sentences


def test_worker_formatted_rows_retain_identity_through_blueprint_and_personalization():
    content = ContentResolveResponse(
        content_id="unified-content", kind=ContentKind.youtube, normalized_key="youtube:unified",
        title="Unified source", language="en", has_transcript=True,
    )
    raw = "0:01\tWe agree. We agree.\n0:04\tWe can proceed."
    rows = format_sentences(raw, "en", syntax_engine=None)
    analysis = BlueprintAnalysis(
        summary="A discussion.", chapters=["Opening"],
        logic_flow=[AnalysisLogicNode(title="Opening", subtitle="An agreement.", timestamp="0:01")],
        key_points=["The speakers agree."], scenario_suggestions=["Discuss a decision."],
    )
    blueprint = blueprint_service.create_blueprint_from_analysis(
        content, raw, analysis, formatted_lines=rows,
    )
    result = blueprint_service.personalize_blueprint(blueprint, "B1")
    assert len(result.transcript) == 3
    for line, row in zip(result.transcript, rows, strict=True):
        assert line.id == row.id
        assert "".join(part if isinstance(part, str) else part.text for part in line.parts) == row.text
        assert line.start_ms == row.start_ms and line.end_ms == row.end_ms
        assert line.segmentation_version == row.segmentation_version
    for segment in result.segments:
        first, last = segment.transcript_start_index, segment.transcript_end_index
        assert all(segment.start_ms <= row.start_ms < row.end_ms <= segment.end_ms for row in rows[first:last])


def test_legacy_upgrade_is_cached_without_modifying_original_or_reanalyzing(monkeypatch):
    from app.integrations import sentence_syntax

    calls = []

    class Syntax:
        def should_merge(self, left, right, source):
            calls.append(source)
            return left.startswith("Although") and "cautious" not in left

    monkeypatch.setattr(sentence_syntax, "get_sentence_syntax", lambda language: Syntax())
    original = Blueprint(
        id="legacy-specific", content_id="legacy-specific", analysis_version="mvp-v9",
        title="Legacy", summary="Keep this cached semantic analysis.",
        logic_flow=[LogicNode(id="logic-1", title="Claim", subtitle="A claim.", time="0:01")],
        transcript=[
            TranscriptLine(time="0:01", parts=["Although the market improved."]),
            TranscriptLine(time="0:04", parts=["We remain cautious."]),
            TranscriptLine(time="0:07", parts=["We agree."]),
        ],
        corpus_items=[CorpusItem(
            id="corpus-kept", kind="chunk", text="remain cautious", source_text="remain cautious",
            tags=["hedging"], meta="0:04 - B1", level="B1",
        )], key_points=["Keep evidence."], scenario_suggestions=["Discuss caution."],
    )
    snapshot = original.model_dump()
    first = blueprint_service.personalize_blueprint(original, "B1")
    calls_after_first = len(calls)
    second = blueprint_service.personalize_blueprint(original, "B2")
    assert len(first.transcript) == 2
    assert first.transcript[0].boundary_source == "syntax_merge"
    assert first.summary == original.summary and first.corpus_items == original.corpus_items
    assert original.model_dump() == snapshot
    assert first.transcript == second.transcript and len(calls) == calls_after_first
    assert first.segments[0].transcript_end_index == 2
    assert any(not isinstance(part, str) and part.text == "remain cautious" for part in first.transcript[0].parts)


def test_segment_bounds_use_estimated_sentence_times_not_shared_caption_label():
    raw = "\n".join(f"{i}:00\tWe agree. We disagree. We will discuss this." for i in range(12))
    rows = format_sentences(raw, "en", syntax_engine=None)
    segments = blueprint_service._build_segments("timing", "mvp-v9", rows, [], [])
    assert len(segments) >= 3
    for segment in segments:
        selected = rows[segment.transcript_start_index:segment.transcript_end_index]
        assert selected and all(segment.start_ms <= row.start_ms < row.end_ms <= segment.end_ms for row in selected)


def test_untimed_legacy_rows_do_not_acquire_timestamp_text():
    blueprint = Blueprint(
        id="untimed-upgrade", content_id="untimed-upgrade", title="Untimed", summary="Untimed",
        logic_flow=[], transcript=[TranscriptLine(time="--:--", parts=["We agree."])],
        key_points=[], scenario_suggestions=[],
    )
    result = blueprint_service.personalize_blueprint(blueprint, None)
    assert result.transcript[0].parts == ["We agree."]
    assert result.transcript[0].start_ms is None
