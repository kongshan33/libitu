import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from app.services import speaking_help as help_service
from app.services import speaking_teaching as teaching
from test_speaking_teaching import mission, utterance


@pytest.fixture(autouse=True)
def no_paid_help(monkeypatch):
    monkeypatch.setattr(help_service, "get_settings", lambda: SimpleNamespace(
        deepseek_api_key=None, deepseek_base_url="https://analyzer.invalid", deepseek_model="fixture-model"))


def help_transport(monkeypatch, result, *, finish_reason="stop"):
    original = httpx.AsyncClient
    requests = []
    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"finish_reason": finish_reason,
                                                     "message": {"content": json.dumps(result)}}]})
    monkeypatch.setattr(help_service, "get_settings", lambda: SimpleNamespace(
        deepseek_api_key="test-only", deepseek_base_url="https://analyzer.invalid", deepseek_model="fixture-model"))
    monkeypatch.setattr(teaching.httpx, "AsyncClient", lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)))
    return requests


def request_help(session, level="usage", message=None):
    return asyncio.run(help_service.generate_help(session, str(session.items[0].id), message, [], level))


def test_direction_is_immediate_without_model_or_example(monkeypatch):
    async def unexpected(*args, **kwargs):
        raise AssertionError("Direction does not need a provider request")
    monkeypatch.setattr(help_service, "request_analysis_json", unexpected)
    result = request_help(mission(), "direction")
    assert result["status"] == "ready" and result["example"] is None
    assert result["analysis_trace"]["skip_reason"] == "direction_uses_basic_help"


def test_usage_retains_base_help_when_provider_unavailable():
    session = mission(("chunk", "to be fair"))
    session.items[0].meaning = "To acknowledge another perspective."
    result = request_help(session)
    assert result["status"] == "unavailable"
    assert result["meaning"] == session.items[0].meaning
    assert result["example"] is None
    assert result["analysis_trace"]["error_type"] == "analyzer_not_configured"


def test_explicit_example_is_grounded_in_selected_expression_and_current_context(monkeypatch):
    requests = help_transport(monkeypatch, {"direction": "Acknowledge their concern.",
        "meaning": "Introduce a balanced view.", "pattern": "To be fair, + clause",
        "example": "To be fair, we could allow another day.", "substitution": "Replace another day with your preferred time."})
    message = utterance("Could you give me an example?")
    result = request_help(mission(("chunk", "to be fair")), "example", message)
    assert result["status"] == "ready" and result["example"].startswith("To be fair")
    context = json.loads(requests[0]["messages"][1]["content"])
    assert context["requested_level"] == "example" and context["current_user_message"] == message["text"]
    assert result["analysis_trace"]["raw_content"]
    assert result["analysis_trace"]["source_message_id"] == message["id"]


@pytest.mark.parametrize("level,example,error", [
    ("usage", "To be fair, we could wait.", "example_not_requested"),
    ("example", "We could wait.", "example_target_not_grounded"),
])
def test_unrequested_or_ungrounded_examples_are_not_shown(monkeypatch, level, example, error):
    help_transport(monkeypatch, {"direction": "Explain your view.", "meaning": "A balanced view.", "example": example})
    result = request_help(mission(("chunk", "to be fair")), level)
    assert result["status"] == "unavailable" and result["example"] is None
    assert result["analysis_trace"]["error_type"] == error


def test_structure_example_requires_all_anchors_and_filled_slots(monkeypatch):
    session = mission(("structure", "The more you [action], the more you [result]"))
    help_transport(monkeypatch, {"direction": "Relate work to time.", "meaning": "Describe a linked increase.",
                                "example": "The more you change the scope, the more you need to adjust the timeline"})
    assert request_help(session, "example")["status"] == "ready"


def test_invalid_selected_item_does_not_call_model(monkeypatch):
    async def unexpected(*args, **kwargs):
        raise AssertionError("Unknown targets must not reach a paid provider")
    monkeypatch.setattr(help_service, "request_analysis_json", unexpected)
    result = asyncio.run(help_service.generate_help(mission(), "not-selected", None, [], "example"))
    assert result["status"] == "unavailable" and result["target_item_id"] is None


@pytest.mark.parametrize("outcome,quote,expected", [
    ("reflected", "What would make this fair for both teams?", "reflected"),
    ("reflected", "Invented quote", "unknown"),
    ("reflected", None, "unknown"),
    ("appropriate_skip", None, "unknown"),
    ("not_reflected", None, "not_reflected"),
])
def test_effect_assessment_requires_exact_response_evidence(monkeypatch, outcome, quote, expected):
    help_transport(monkeypatch, {"outcome": outcome, "exact_quote": quote, "reason": "The requested opportunity is present."})
    result = asyncio.run(help_service.assess_policy_response(
        {"intent": "Acknowledge their concern", "opportunity": "Ask for a fair compromise"},
        "What would make this fair for both teams?"))
    assert result["outcome"] == expected
    if expected == "unknown":
        assert result["exact_quote"] is None and result["analysis_trace"]["error_type"]


def test_effect_failure_stays_unknown_and_empty_response_skips_model():
    assert asyncio.run(help_service.assess_policy_response({}, ""))["outcome"] == "unknown"
    result = asyncio.run(help_service.assess_policy_response({}, "We should discuss the deadline."))
    assert result["outcome"] == "unknown" and result["analysis_trace"]["status"] == "unavailable"


@pytest.mark.parametrize("response,quote", [
    ("One trade-off is that reliability costs more. Would you raise the budget?", "One trade-off is"),
    ("😊 ONE trade-off is a higher monthly cost. What do you think?", "ONE trade-off is"),
    ('Try saying "One trade-off is" to compare the options.', "One trade-off is"),
])
def test_implicit_target_exposure_is_deterministic_and_never_overridden_by_model(monkeypatch, response, quote):
    async def unexpected(*args, **kwargs):
        raise AssertionError("A known constraint violation cannot become a positive model judgment")
    monkeypatch.setattr(help_service, "request_analysis_json", unexpected)
    policy = {"action": "implicit_elicitation", "target_item_id": "selected-target",
              "target_text": "One trade-off is", "target_kind": "chunk"}
    result = asyncio.run(help_service.assess_policy_response(policy, response))
    assert result["outcome"] == "not_reflected" and result["exact_quote"] == quote
    trace = result["analysis_trace"]
    assert trace["status"] == "skipped" and trace["skip_reason"] == "implicit_target_exposed"
    assert trace["assessment_source"] == "deterministic_constraint"
    assert trace["constraint_check"] == {
        "name": "implicit_target_not_spoken", "status": "failed", "target_item_id": "selected-target",
        "exact_quote": quote, "match_type": "exact"}


@pytest.mark.parametrize("response,exposed", [
    ("The more you change the scope, the more you need to adjust the timeline.", True),
    ("Remember, the more you change the scope, the more you need to adjust the timeline today.", True),
    ("The more you change the scope. The more you need to adjust the timeline.", False),
    ("The more you change the scope, the more you.", False),
    ("How would changing the scope affect the timeline?", False),
])
def test_implicit_filled_structure_exposure_requires_sentence_local_anchors_and_slots(monkeypatch, response, exposed):
    requests = help_transport(monkeypatch, {"outcome": "reflected", "exact_quote": response,
                                           "reason": "It invites the learner to explain the connection."})
    result = asyncio.run(help_service.assess_policy_response({
        "action": "implicit_elicitation", "target_text": "The more you [action], the more you [result]",
        "target_kind": "structure"}, response))
    assert result["outcome"] == ("not_reflected" if exposed else "reflected")
    assert len(requests) == (0 if exposed else 1)
    assert result["analysis_trace"]["constraint_check"]["status"] == ("failed" if exposed else "passed")
    if exposed:
        assert result["analysis_trace"]["constraint_check"]["match_type"] == "structure"
        assert result["exact_quote"] in response


def test_implicit_opportunity_is_still_assessed_in_background_with_private_target_context(monkeypatch):
    response = "How would you weigh the lower bill against the extra maintenance?"
    requests = help_transport(monkeypatch, {"outcome": "reflected", "exact_quote": response,
                                           "reason": "It asks the learner to express the compromise."})
    result = asyncio.run(help_service.assess_policy_response({
        "action": "implicit_elicitation", "target_text": "One trade-off is", "target_kind": "chunk",
        "intent": "Have the learner compare the options", "opportunity": "Ask them to express a compromise"}, response))
    assert result["outcome"] == "reflected"
    assert result["analysis_trace"]["constraint_check"]["status"] == "passed"
    assert result["analysis_trace"]["assessment_source"] == "model_advisory"
    context = json.loads(requests[0]["messages"][1]["content"])
    assert context["policy"]["target_text"] == "One trade-off is"
    assert "LEARNER must perform" in requests[0]["messages"][0]["content"]


@pytest.mark.parametrize("target", [None, "", " ", 1, "x" * 1001])
def test_legacy_implicit_policy_without_valid_target_cannot_claim_reflection(monkeypatch, target):
    async def unexpected(*args, **kwargs):
        raise AssertionError("Unknown disclosure compliance cannot authorize an automatic direction card")
    monkeypatch.setattr(help_service, "request_analysis_json", unexpected)
    result = asyncio.run(help_service.assess_policy_response(
        {"action": "implicit_elicitation", "target_text": target}, "How would you compare the options?"))
    assert result["outcome"] == "unknown"
    assert result["analysis_trace"]["skip_reason"] == "target_context_missing"
    assert result["analysis_trace"]["constraint_check"]["status"] == "unavailable"


def test_explicit_help_is_allowed_to_name_target(monkeypatch):
    response = "One trade-off is a way to introduce a compromise."
    requests = help_transport(monkeypatch, {"outcome": "reflected", "exact_quote": response,
                                           "reason": "It supplies the explicitly requested wording help."})
    result = asyncio.run(help_service.assess_policy_response({
        "action": "explicit_hint", "target_text": "One trade-off is", "target_kind": "chunk"}, response))
    assert result["outcome"] == "reflected" and len(requests) == 1
    assert "constraint_check" not in result["analysis_trace"]


def test_whole_help_request_timeout_is_bounded_without_exposing_provider_exception(monkeypatch):
    original = httpx.AsyncClient
    async def handler(request):
        await asyncio.sleep(0.1)
        raise AssertionError("The whole-operation deadline should cancel this request")
    monkeypatch.setattr(help_service, "get_settings", lambda: SimpleNamespace(
        deepseek_api_key="test-only", deepseek_base_url="https://analyzer.invalid", deepseek_model="fixture-model"))
    monkeypatch.setattr(teaching, "ANALYSIS_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(teaching.httpx, "AsyncClient", lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)))
    result = request_help(mission())
    assert result["status"] == "unavailable" and result["analysis_trace"]["error_type"] == "timeout"
    assert "test-only" not in json.dumps(result)
