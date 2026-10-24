"""Exercise the real Doubao HTTP paths without network or local credentials."""
import asyncio
import json

import httpx
import pytest

from app.config import Settings
from app.integrations import ark_analysis, ark_selection
from app.schemas.content import ContentKind, ContentResolveResponse
from app.schemas.corpus import CorpusSelectionAnalysisRequest
from app.services import speaking_assessment, speaking_teaching
from test_smoke import selection_analysis_result
from test_speaking_assessment import model, source


def test_text_configuration_uses_ark_key_and_independent_model(monkeypatch):
    monkeypatch.setenv("ARK_API_KEY", "fixture-ark-key")
    monkeypatch.setenv("GEMINI_API_KEY", "fixture-voice-key")
    monkeypatch.setenv("ARK_MODEL", "fixture-text-model")
    monkeypatch.setenv("GEMINI_LIVE_MODEL", "fixture-live-model")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "obsolete-fixture-key")
    monkeypatch.setenv("DEEPSEEK_MODEL", "obsolete-fixture-model")
    settings = Settings(_env_file=None)
    assert settings.ark_is_configured
    assert settings.ark_api_key == "fixture-ark-key"
    assert settings.gemini_api_key == "fixture-voice-key"
    assert settings.ark_model == "fixture-text-model"
    assert settings.gemini_live_model == "fixture-live-model"
    monkeypatch.setenv("ARK_API_KEY", "")
    assert not Settings(_env_file=None).ark_is_configured


@pytest.mark.parametrize("task", ["blueprint", "selection", "teaching", "assessment"])
def test_all_text_requests_use_ark_endpoint_and_parameters(monkeypatch, task):
    settings = Settings.model_construct(ark_api_key="fixture-ark-key")
    calls = []
    blueprint = {"summary": "A synthetic discussion.", "chapters": ["Opening"],
                 "logic_flow": [{"title": "Opening", "subtitle": "Consider both plans."}],
                 "corpus_items": [], "key_points": ["Be fair."],
                 "scenario_suggestions": ["Compare two plans"]}
    outputs = {"blueprint": blueprint,
               "selection": selection_analysis_result("to be fair").model_dump(by_alias=True),
               "teaching": {"ok": True}, "assessment": model(source())}

    def handler(request):
        assert str(request.url) == (
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
        )
        assert request.headers["Authorization"] == "Bearer fixture-ark-key"
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload["model"] == settings.ark_model
        assert payload["model"] != settings.gemini_live_model
        assert payload["response_format"] == {"type": "json_object"}
        assert payload["thinking"] == {"type": "disabled"}
        assert "reasoning_effort" not in payload
        raw = json.dumps(outputs[task])
        if task == "blueprint":
            assert payload["stream"] is True
            # Doubao can deliver usage separately after the completed choice.
            chunks = [{"choices": [{"delta": {"content": raw}, "finish_reason": "stop"}]},
                      {"choices": [], "usage": {"completion_tokens": 100}}]
            text = "\n\n".join(f"data: {json.dumps(chunk)}" for chunk in chunks)
            return httpx.Response(200, text=text + "\n\ndata: [DONE]\n\n")
        assert payload["stream"] is False
        return httpx.Response(200, json={"choices": [
            {"finish_reason": "stop", "message": {"content": raw}}
        ]})

    sync_client, async_client = httpx.Client, httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: sync_client(**kwargs, transport=transport))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: async_client(**kwargs, transport=transport))
    for module in (ark_analysis, ark_selection, speaking_teaching, speaking_assessment):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    ark_analysis._ark_analysis_client.cache_clear()
    ark_selection._selection_client.cache_clear()
    try:
        if task == "blueprint":
            previews = []
            result = ark_analysis.analyze_transcript(
                ContentResolveResponse(content_id="fixture", normalized_key="youtube:fixture",
                                       kind=ContentKind.youtube, language="en"),
                "0:01\tTo be fair, both plans could work.", on_progress=previews.append,
            )
            assert result.summary == blueprint["summary"] and previews
        elif task == "selection":
            result = ark_selection.generate_selection_analysis(CorpusSelectionAnalysisRequest(
                selected_text="to be fair", current_sentence="To be fair, both plans could work."))
            assert result.analysis_source == "ai"
        elif task == "teaching":
            raw, trace = asyncio.run(speaking_teaching.request_analysis_json(
                settings, "Return JSON.", {}, prompt_version="fixture"))
            assert json.loads(raw) == {"ok": True}
            assert trace["model"] == settings.ark_model
        else:
            result = asyncio.run(speaking_assessment._assess_with_provider(source()))
            assert result is not None
        assert len(calls) == 1
    finally:
        if task == "blueprint":
            ark_analysis._ark_analysis_client().close()
        if task == "selection":
            ark_selection._selection_client().close()
        ark_analysis._ark_analysis_client.cache_clear()
        ark_selection._selection_client.cache_clear()
