import json
from types import SimpleNamespace

import httpx
import pytest

from app.integrations import deepseek
from app.integrations.deepseek import AnalysisProviderError
from app.schemas.content import ContentKind, ContentResolveResponse


def test_response_normalizes_evidenced_chunk_format_variance() -> None:
    response = _response(
        200,
        {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": """
                        {
                          "summary": "A useful discussion.",
                          "chapters": ["Opening"],
                          "logic_flow": [{"title": "Opening", "subtitle": "The main idea.", "timestamp": "0:01"}],
                          "corpus_items": [
                            {
                              "kind": "CHUNK",
                              "text": "to be completely fair",
                              "source_text": "to be fair",
                              "meaning": "concedes a point",
                              "usage_note": "Use before presenting a different view.",
                              "tags": ["Acknowledging", "Softening", "Discourse", "Framing"],
                              "pattern_family": null,
                              "timestamp": "0:01",
                              "level": "b1",
                              "register": "professional",
                              "scenario_tags": ["workplace", "disagreement"],
                              "phonology_note": null,
                              "naturalness_score": 5,
                              "transferability_score": 5,
                              "learning_value_score": 5
                            },
                            {
                              "kind": "structure",
                              "text": "[claim] depends on [condition]"
                            }
                          ],
                          "key_points": ["Evidence is retained."],
                          "scenario_suggestions": ["Concede a point"]
                        }
                        """
                    },
                }
            ]
        },
    )

    analysis = deepseek._parse_analysis_response(
        response,
        "0:01\tTo be fair, there is another side to this.",
    )

    assert analysis.corpus_items[0].text == "to be fair"
    assert analysis.corpus_items[0].source_text == "to be fair"
    assert analysis.corpus_items[0].kind == "chunk"
    assert analysis.corpus_items[0].level == "B1"
    assert analysis.corpus_items[0].tags == ["acknowledging", "softening", "discourse"]
    assert len(analysis.corpus_items) == 1


def test_truncated_response_retries_with_larger_output_budget(monkeypatch) -> None:
    client = _FakeClient(
        [
            _stream_response("{", "length", 32000),
            _stream_response("{", "length", 64000),
        ]
    )
    monkeypatch.setattr(deepseek, "get_settings", lambda: _settings())
    monkeypatch.setattr(deepseek, "_deepseek_client", lambda: client)
    monkeypatch.setattr(deepseek, "sleep", lambda _seconds: None)

    with pytest.raises(AnalysisProviderError) as raised:
        deepseek.analyze_transcript(_content(), "0:01\tA short transcript.")

    assert raised.value.code == "analysis_response_truncated"
    assert raised.value.diagnostic == (
        "finish_reason=length;completion_tokens=64000;max_tokens=64000"
    )
    assert [call["max_tokens"] for call in client.payloads] == [32000, 64000]
    assert all(call["stream"] is True for call in client.payloads)


def test_stream_emits_validated_partial_analysis_preview(monkeypatch) -> None:
    content = json.dumps(
        {
            "summary": "A streamed discussion.",
            "chapters": ["Opening"],
            "logic_flow": [
                {"title": "Framing the question", "subtitle": "The speaker sets context.", "timestamp": "0:01"}
            ],
            "corpus_items": [
                {
                    "kind": "chunk",
                    "text": "to be fair",
                    "source_text": "to be fair",
                    "meaning": "concedes a point",
                    "usage_note": "Use before presenting a different view.",
                    "tags": ["acknowledging"],
                    "pattern_family": None,
                    "timestamp": "0:01",
                    "level": "B1",
                    "register": "professional",
                    "scenario_tags": ["workplace", "disagreement"],
                    "phonology_note": None,
                    "naturalness_score": 4,
                    "transferability_score": 5,
                    "learning_value_score": 4,
                }
            ],
            "key_points": ["One point"],
            "scenario_suggestions": ["Discuss a tradeoff"],
        }
    )
    client = _FakeClient([_stream_response(content, "stop", 420)])
    previews = []
    monkeypatch.setattr(deepseek, "get_settings", lambda: _settings())
    monkeypatch.setattr(deepseek, "_deepseek_client", lambda: client)

    analysis = deepseek.analyze_transcript(
        _content(),
        "0:01\tTo be fair, there is another side.",
        previews.append,
    )

    assert analysis.summary == "A streamed discussion."
    assert previews[-1].summary == analysis.summary
    assert len(previews[-1].logic_flow) == 1
    assert [item.text for item in previews[-1].corpus_items] == ["to be fair"]
    assert previews[-1].transcript_lines == []


def test_retry_preview_never_regresses_to_an_empty_partial_object() -> None:
    previous = deepseek._build_analysis_preview(
        '{"summary":"Already visible.","chapters":["Opening"],'
        '"logic_flow":[{"title":"Framing the idea","subtitle":"The premise.","timestamp":"0:01"}]}',
        "0:01\tThe premise is already visible.",
    )
    restarted = deepseek._build_analysis_preview(
        '{',
        "0:01\tThe premise is already visible.",
    )

    merged = deepseek._merge_analysis_preview(previous, restarted)

    assert merged.summary == "Already visible."
    assert merged.chapters == ["Opening"]
    assert len(merged.logic_flow) == 1
    assert merged.output_chars == previous.output_chars


def test_incomplete_json_exposes_only_closed_semantic_fields() -> None:
    preview = deepseek._build_analysis_preview(
        """
        {
          "summary": "Still streaming.",
          "chapters": ["Opening"],
        """,
        "0:01\tThis is the first thought\n0:05\tand this sentence is still open",
    )

    assert preview.summary == "Still streaming."
    assert preview.chapters == ["Opening"]
    assert preview.transcript_lines == []


def test_prompt_leaves_subtitle_formatting_to_local_pipeline() -> None:
    assert '"sentence_boundaries"' not in deepseek.SYSTEM_PROMPT
    assert "transcript_sentences" not in deepseek.SYSTEM_PROMPT


def test_prompt_and_schema_support_idioms() -> None:
    assert 'kind              "chunk" | "idiom" | "structure"' in deepseek.SYSTEM_PROMPT
    normalized = deepseek._normalize_corpus_item(
        {
            "kind": "IDIOM",
            "text": "double down on",
            "source_text": "doubled down on",
            "meaning": "Commit more strongly to a course of action.",
            "usage_note": "Use when someone increases commitment despite pressure.",
            "tags": ["Idiom", "Emphasising"],
            "pattern_family": None,
            "timestamp": "0:10",
            "level": "b2",
            "register": "Professional",
            "scenario_tags": ["Workplace", "Presentation"],
            "phonology_note": None,
            "naturalness_score": 4,
            "transferability_score": 4,
            "learning_value_score": 5,
        },
        "they doubled down on the original plan",
    )

    item = deepseek.AnalysisCorpusItem.model_validate(normalized)
    assert item.kind == "idiom"
    assert item.text == "double down on"
    assert item.source_text == "doubled down on"
    assert item.usage_register == "professional"


def test_oversized_transcript_fails_instead_of_silent_truncation(monkeypatch) -> None:
    settings = _settings()
    settings.deepseek_max_input_chars = 10
    client = _FakeClient([])
    monkeypatch.setattr(deepseek, "get_settings", lambda: settings)
    monkeypatch.setattr(deepseek, "_deepseek_client", lambda: client)

    with pytest.raises(AnalysisProviderError) as raised:
        deepseek.analyze_transcript(_content(), "0:01\tThis transcript exceeds the limit.")

    assert raised.value.code == "analysis_input_too_large"
    assert client.payloads == []


def test_rejected_request_is_not_retried_as_schema_failure(monkeypatch) -> None:
    client = _FakeClient([_response(400, {"error": {"message": "bad request"}})])
    monkeypatch.setattr(deepseek, "get_settings", lambda: _settings())
    monkeypatch.setattr(deepseek, "_deepseek_client", lambda: client)

    with pytest.raises(AnalysisProviderError) as raised:
        deepseek.analyze_transcript(_content(), "0:01\tA short transcript.")

    assert raised.value.code == "analysis_provider_rejected"
    assert str(raised.value) == "DeepSeek rejected the blueprint request (HTTP 400)."
    assert len(client.payloads) == 1


class _FakeClient:
    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = responses
        self.payloads: list[dict] = []

    def stream(self, method: str, _path: str, *, headers: dict, json: dict):
        assert method == "POST"
        assert headers["Authorization"].startswith("Bearer ")
        self.payloads.append(json)
        return _FakeStream(self.responses.pop(0))


class _FakeStream:
    def __init__(self, response: httpx.Response) -> None:
        self.response = response

    def __enter__(self) -> httpx.Response:
        return self.response

    def __exit__(self, *_args) -> None:
        return None


def _response(status: int, payload: dict) -> httpx.Response:
    return httpx.Response(
        status,
        json=payload,
        request=httpx.Request("POST", "https://api.deepseek.com/chat/completions"),
    )


def _stream_response(content: str, finish_reason: str, completion_tokens: int) -> httpx.Response:
    chunks = [
        {
            "choices": [
                {
                    "delta": {"content": content},
                    "finish_reason": None,
                }
            ],
            "usage": None,
        },
        {
            "choices": [
                {
                    "delta": {"content": ""},
                    "finish_reason": finish_reason,
                }
            ],
            "usage": {"completion_tokens": completion_tokens},
        },
    ]
    body = "\n\n".join([*(f"data: {json.dumps(chunk)}" for chunk in chunks), "data: [DONE]"])
    return httpx.Response(
        200,
        text=body,
        headers={"Content-Type": "text/event-stream"},
        request=httpx.Request("POST", "https://api.deepseek.com/chat/completions"),
    )


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        deepseek_api_key="test-key",
        deepseek_model="deepseek-v4-flash",
        deepseek_max_input_chars=240_000,
        deepseek_max_output_tokens=32_000,
        deepseek_max_attempts=2,
    )


def _content() -> ContentResolveResponse:
    return ContentResolveResponse(
        content_id="content-deepseek-test",
        kind=ContentKind.youtube,
        normalized_key="youtube:deepseek-test",
        title="DeepSeek test",
        language="en",
    )
