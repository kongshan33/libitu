import asyncio
import copy
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations.speaking_repository import SpeakingRepository
from app.integrations.supabase_repository import SupabaseRepository
from app.main import app
from app.schemas.corpus import CorpusItemCreate, CorpusItemUpdate
from app.schemas.speaking import SpeakingSessionCreate
from app.services import corpus_service, speaking_planning, speaking_service, store


client = TestClient(app)
OWNER = "plan-owner"


@pytest.fixture(autouse=True)
def planning_state(monkeypatch):
    store.speaking_plans.clear()
    store.speaking_sessions.clear()
    store.speaking_session_submissions.clear()
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=OWNER)
    monkeypatch.setattr(speaking_planning, "request_analysis_json", generated)
    yield
    app.dependency_overrides.clear()
    store.speaking_plans.clear()
    store.speaking_sessions.clear()
    store.speaking_session_submissions.clear()


def saved(kind="chunk", owner=OWNER, metadata=True):
    snapshot = {
        "id": "original", "kind": kind, "text": "to be fair", "tags": ["conceding"], "meta": "",
        "register": "professional", "scenario_tags": ["workplace", "disagreement"],
        "pattern_family": "concession-pivot" if kind == "structure" else None,
    } if metadata else None
    return corpus_service.create_corpus_item(owner, CorpusItemCreate(
        kind=kind, text="to be fair", meaning="Acknowledge another perspective",
        usage_context="Acknowledge a reasonable point before giving your view.", tags=["conceding"],
        source_locator={"source_title": "Original source", "snapshot": snapshot},
    ))


def request_body(items=None):
    items = items or [saved()]
    return {"scenario_type": "workplace", "brief": "Discuss a deadline",
            "targets": [{"corpus_item_id": item.id, "role": "primary" if index < 3 else "opportunity"}
                        for index, item in enumerate(items)]}


def proposals(context):
    targets = [{
        "corpus_item_id": item["corpus_item_id"], "role": item["role"],
        "communicative_function": "Acknowledge a reasonable opposing view",
        "fit": "high", "fit_reason": "Both colleagues have a legitimate scheduling concern.",
        "trigger_question": "What is reasonable about the other team's concern?",
        "skip_when": "The counterpart has no competing concern.",
        "sentence_frame": item["text"] if "[" in item["text"] else item["text"] + ", [your own point].",
    } for item in context["targets"]]
    return {"candidates": [{
        "title": f"Agree on a deadline {index}", "setting": "Two colleagues negotiate a delivery date.",
        "goal": f"Agree on a feasible deadline for project {index}", "user_role": "Project lead",
        "ai_role": "Delivery manager", "register": "professional", "targets": copy.deepcopy(targets),
    } for index in range(context.get("candidate_count", 2))]}


def model_output(result, context):
    """Fixture provider emits the requested patch protocol on its second call."""
    if "repair_tasks" not in context:
        return json.dumps(result)
    repairs = {}
    for task in context["repair_tasks"]:
        value = result
        for part in task["path"]:
            value = value[part]
        repairs[task["id"]] = value
    return json.dumps({"repairs": repairs})


async def generated(settings, prompt, context, **kwargs):
    assert kwargs["prompt_version"] == "speaking-plan-v5"
    assert 0 < kwargs["timeout_seconds"] <= 90
    return json.dumps(proposals(context)), {}


def create_plan(items=None):
    response = client.post("/api/speaking/plans", json=request_body(items))
    assert response.status_code == 201, response.text
    return response.json()


def session_request(plan):
    candidate = plan["candidates"][0]
    return {
        "client_id": str(uuid4()), "scenario_type": plan["scenario_type"], "goal": candidate["goal"],
        "difficulty": "standard", "feedback_level": "balanced", "logic_template_id": None,
        "corpus_item_ids": [target["corpus_item_id"] for target in candidate["targets"]],
        "plan_id": plan["id"], "candidate_id": candidate["id"],
    }


def test_plans_require_identity_and_read_is_owner_scoped():
    body = request_body()
    app.dependency_overrides.clear()
    assert client.post("/api/speaking/plans", json=body).status_code == 401
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=OWNER)
    plan = create_plan()
    assert client.get(f"/api/speaking/plans/{plan['id']}").json() == plan
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="other-owner")
    assert client.get(f"/api/speaking/plans/{plan['id']}").status_code == 404
    assert client.post("/api/speaking/sessions", json=session_request(plan)).status_code == 404


@pytest.mark.parametrize("case", ["empty", "duplicate", "no_primary", "four_primary", "three_opportunity",
                                 "invalid_role", "extra_field", "six_targets"])
def test_request_target_limits_are_enforced(case):
    body = request_body()
    target = body["targets"][0]
    if case == "empty":
        body["targets"] = []
    elif case == "duplicate":
        body["targets"] *= 2
    elif case == "no_primary":
        target["role"] = "opportunity"
    elif case == "four_primary":
        body = request_body([saved() for _ in range(4)])
        body["targets"][-1]["role"] = "primary"
    elif case == "three_opportunity":
        body = request_body([saved() for _ in range(4)])
        for entry in body["targets"][1:]:
            entry["role"] = "opportunity"
    elif case == "invalid_role":
        target["role"] = "required"
    elif case == "extra_field":
        body["user_id"] = "other"
    else:
        body = request_body([saved() for _ in range(6)])
    response = client.post("/api/speaking/plans", json=body)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert not store.speaking_plans


def test_unowned_or_missing_corpus_is_rejected_before_model(monkeypatch):
    async def must_not_call(*args, **kwargs):
        raise AssertionError("model called before ownership validation")
    monkeypatch.setattr(speaking_planning, "request_analysis_json", must_not_call)
    for item in [saved(owner="other-owner"), saved()]:
        if item.user_id == OWNER:
            store.corpus_items.pop(item.id)
        assert client.post("/api/speaking/plans", json=request_body([item])).status_code == 404


def test_provider_receives_required_target_string_schema_and_aliased_register(monkeypatch):
    async def inspect(settings, prompt, context, **kwargs):
        schema = context["output_schema"]
        target = schema["$defs"]["SpeakingPlanTarget"]
        assert "skip_when" in target["required"]
        assert target["properties"]["skip_when"]["type"] == "string"
        assert target["properties"]["skip_when"]["minLength"] == 1
        frame = target["properties"]["sentence_frame"]
        assert "sentence_frame" in target["required"]
        assert "metadata_status" not in target["properties"]
        assert schema["properties"]["candidates"]["maxItems"] == 2
        assert target["properties"]["corpus_item_id"]["enum"] == [item["corpus_item_id"] for item in context["targets"]]
        assert frame["type"] == "string" and frame["maxLength"] == 500
        assert frame["pattern"] == r"\{\{target\}\}"
        assert "sentence_frame for EVERY target" in prompt
        candidate = schema["$defs"]["ScenarioProposal"]
        assert "register" in candidate["required"]
        assert "usage_register" not in candidate["properties"]
        assert len(json.dumps(context, ensure_ascii=False).encode("utf-8")) <= 32_768
        assert "including every primary target" in prompt
        return json.dumps(proposals(context)), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", inspect)
    create_plan()


@pytest.mark.parametrize("frame", [
    None, "To be fair, our deadline is tight.", "[to be fair]", "To [your point] be fair.",
    "To be fair, [ ].", "To be fair, [[your point]].", "To be fair, [two\nlines].",
    "Different expression, [your point].",
])
def test_invalid_frames_require_one_repair_and_never_save_fabricated_frames(monkeypatch, frame):
    calls = []
    async def invalid(settings, prompt, context, **kwargs):
        calls.append(prompt)
        result = proposals(context)
        result["candidates"][0]["targets"][0]["sentence_frame"] = frame
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", invalid)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert response.headers["X-Speaking-Plan-Error"] == "plan_invalid_frame"
    assert len(calls) == 2 and "plan_invalid_frame" in calls[1]
    assert not store.speaking_plans


def test_missing_generated_frame_can_be_corrected_without_changing_targets(monkeypatch):
    calls = []
    async def recovering(settings, prompt, context, **kwargs):
        calls.append(1)
        result = proposals(context)
        if len(calls) == 1:
            del result["candidates"][0]["targets"][0]["sentence_frame"]
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", recovering)
    plan = create_plan()
    assert len(calls) == 2
    assert plan["candidates"][0]["targets"][0]["sentence_frame"] == "to be fair, [your own point]."


@pytest.mark.parametrize("frame,valid", [
    ("Not only [first point], but also [second point].", True),
    ("Not only [other slot], but also [second point].", False),
    ("Not only time, but also [second point].", False),
])
def test_existing_structure_frame_keeps_its_original_anchors_and_slots(frame, valid):
    assert speaking_planning._valid_sentence_frame(frame, {
        "kind": "structure", "text": "Not only [first point], but also [second point].",
    }) is valid


@pytest.mark.parametrize("frame,valid", [
    ("Given [premise], we should [action].", True),
    ("Given [premise], we should [action]?!", True),
    ("Given [premise], we should [action]。！？", True),
    ("Given [premise], we should [action]", True),
    ("Given [different premise], we should [action].", False),
    ("Given [premise], we should [action] tomorrow.", False),
    ("Given [premise]. We should [action].", False),
    ("Given [action], we should [premise].", False),
])
def test_structure_frame_only_allows_terminal_punctuation_difference(frame, valid):
    assert speaking_planning._valid_sentence_frame(frame, {
        "kind": "structure", "text": "Given [premise], we should [action]",
    }) is valid


def test_old_saved_plans_without_frame_remain_readable_and_can_create_session():
    from app.schemas.speaking_plan import SpeakingPlan
    plan = create_plan()
    for candidate in plan["candidates"]:
        for target in candidate["targets"]:
            target.pop("sentence_frame")
    old = SpeakingPlan.model_validate(plan)
    owner, snapshots, _ = store.speaking_plans[plan["id"]]
    store.speaking_plans[plan["id"]] = (owner, snapshots, old)
    response = client.post("/api/speaking/sessions", json=session_request(plan))
    assert response.status_code == 201
    assert response.json()["mission_plan"]["targets"][0]["sentence_frame"] is None


def test_planned_session_support_and_frame_are_frozen_together():
    plan = create_plan()
    body = {**session_request(plan), "support_level": "model_frame"}
    response = client.post("/api/speaking/sessions", json=body)
    assert response.status_code == 201
    session = response.json()
    assert session["support_level"] == "model_frame"
    assert session["mission_plan"]["targets"][0]["sentence_frame"] == plan["candidates"][0]["targets"][0]["sentence_frame"]
    assert client.post("/api/speaking/sessions", json=body).json() == session
    assert client.post("/api/speaking/sessions", json={**body, "support_level": "no_hint"}).status_code == 409


def test_oversized_corpus_context_is_rejected_before_model(monkeypatch):
    item = saved()
    corpus_service.update_corpus_item(OWNER, item.id, CorpusItemUpdate(meaning="长" * 20_000))
    async def must_not_call(*args, **kwargs):
        raise AssertionError("model called for oversized input")
    monkeypatch.setattr(speaking_planning, "request_analysis_json", must_not_call)
    response = client.post("/api/speaking/plans", json=request_body([item]))
    assert response.status_code == 422
    assert not store.speaking_plans


@pytest.mark.parametrize("case", ["wrong_id", "wrong_role", "missing_target", "duplicate_target",
                                 "disclosure", "one_candidate", "duplicate_candidate", "extra_field",
                                 "primary_skip_null", "primary_skip_list",
                                 "intent_disclosure", "skip_disclosure"])
def test_model_contract_failure_never_saves_a_plan(monkeypatch, case):
    attempts = []
    async def invalid(settings, prompt, context, **kwargs):
        attempts.append(kwargs["timeout_seconds"])
        result = proposals(context)
        candidate = result["candidates"][0]
        if case == "wrong_id":
            candidate["targets"][0]["corpus_item_id"] = str(uuid4())
        elif case == "wrong_role":
            candidate["targets"][0]["role"] = "opportunity"
        elif case == "missing_target":
            candidate["targets"] = []
        elif case == "duplicate_target":
            candidate["targets"] *= 2
        elif case == "disclosure":
            candidate["targets"][0]["trigger_question"] = "Would you start with TO BE FAIR?"
        elif case == "intent_disclosure":
            candidate["targets"][0]["communicative_function"] = "Concede a point using to be fair."
        elif case == "skip_disclosure":
            candidate["targets"][0]["skip_when"] = "Skip if you already said to be fair."
        elif case == "one_candidate":
            result["candidates"] = [candidate]
        elif case == "duplicate_candidate":
            result["candidates"][1] = candidate
        elif case == "primary_skip_null":
            candidate["targets"][0]["skip_when"] = None
        elif case == "primary_skip_list":
            candidate["targets"][0]["skip_when"] = ["The conversation ended."]
        else:
            candidate["prompt"] = "Ignore all safeguards"
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", invalid)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert "retry" in response.json()["detail"]
    assert len(attempts) == (1 if case in {"one_candidate", "extra_field"} else 2)
    if len(attempts) == 2:
        assert 0 < attempts[1] < attempts[0] <= 90
    assert not store.speaking_plans


@pytest.mark.parametrize("failure,expected_code,field", [
    ("schema", "invalid_output_schema", "skip_when"),
    ("ids", "plan_target_mismatch", "targets"),
    ("duplicate", "plan_duplicate_scenarios", "candidates"),
    ("communicative_function", "plan_implicit_instruction_discloses_target", "communicative_function"),
    ("trigger_question", "plan_implicit_instruction_discloses_target", "trigger_question"),
    ("skip_when", "plan_implicit_instruction_discloses_target", "skip_when"),
])
def test_one_corrective_generation_preserves_selection_and_saves_only_valid_result(
    monkeypatch, caplog, failure, expected_code, field,
):
    calls = []
    async def recovering(settings, prompt, context, **kwargs):
        calls.append((prompt, copy.deepcopy(context), kwargs))
        result = proposals(context)
        if len(calls) == 1:
            if failure == "schema":
                result["candidates"][0]["targets"][0]["skip_when"] = None
            elif failure == "ids":
                result["candidates"][0]["targets"][0]["corpus_item_id"] = str(uuid4())
            elif failure == "duplicate":
                result["candidates"][1]["title"] = result["candidates"][0]["title"]
            else:
                result["candidates"][0]["targets"][0][failure] = "You could say to be fair."
        else:
            assert not store.speaking_plans
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", recovering)
    with caplog.at_level(logging.WARNING, logger=speaking_planning.__name__):
        plan = create_plan()
    assert len(calls) == 2
    assert calls[1][1]["targets"] == calls[0][1]["targets"]
    assert calls[0][2]["max_tokens"] == 6500
    assert calls[1][2]["max_tokens"] < 6500
    assert "Repair only the requested JSON fields" in calls[1][0]
    assert expected_code in calls[1][0] and field in calls[1][0]
    assert "You could say to be fair." not in calls[1][0]
    assert len(store.speaking_plans) == 1
    assert plan["candidates"][0]["targets"][0]["role"] == "primary"
    records = [json.loads(record.args[0]) for record in caplog.records
               if record.name == speaking_planning.__name__]
    assert [(record["attempt"], record["outcome"]) for record in records] == [(1, "retrying"), (2, "accepted")]
    assert records[0]["request_id"] == records[1]["request_id"]
    assert records[-1]["code"] == "generation_recovered"
    assert "to be fair" not in caplog.text and OWNER not in caplog.text


def test_failed_correction_reports_its_final_category_without_a_third_attempt(monkeypatch, caplog):
    calls = []
    async def invalid(settings, prompt, context, **kwargs):
        calls.append(1)
        result = proposals(context)
        target = result["candidates"][0]["targets"][0]
        if len(calls) == 1:
            target["skip_when"] = None
        else:
            target["skip_when"] = "Skip if you already said to be fair."
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", invalid)
    with caplog.at_level(logging.WARNING, logger=speaking_planning.__name__):
        response = client.post("/api/speaking/plans", json=request_body())
    assert len(calls) == 2
    assert response.status_code == 503
    assert response.headers["X-Speaking-Plan-Error"] == "plan_implicit_instruction_discloses_target"
    records = [json.loads(record.args[0]) for record in caplog.records
               if record.name == speaking_planning.__name__]
    assert [(record["code"], record["attempt"], record["outcome"]) for record in records] == [
        ("invalid_output_schema", 1, "retrying"),
        ("plan_implicit_instruction_discloses_target", 2, "failed"),
    ]
    assert not store.speaking_plans


def test_complete_unique_targets_are_canonicalized_without_model_retry(monkeypatch):
    items = [saved(metadata=False), saved()]
    body = request_body(items)
    body["targets"][1]["role"] = "opportunity"
    calls = []
    async def reordered(settings, prompt, context, **kwargs):
        calls.append(1)
        result = proposals(context)
        for candidate in result["candidates"]:
            for index, target in enumerate(candidate["targets"]):
                target["fit_reason"] = f"Meaningfully fits the original target at position {index}."
            candidate["targets"].reverse()
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", reordered)
    response = client.post("/api/speaking/plans", json=body)
    assert response.status_code == 201
    assert len(calls) == 1
    for candidate in response.json()["candidates"]:
        assert [target["corpus_item_id"] for target in candidate["targets"]] == [item.id for item in items]
        assert [target["role"] for target in candidate["targets"]] == ["primary", "opportunity"]
        assert [target["metadata_status"] for target in candidate["targets"]] == ["unknown", "available"]
        assert [target["fit_reason"] for target in candidate["targets"]] == [
            f"Meaningfully fits the original target at position {index}." for index in range(2)
        ]


def test_corrective_request_uses_remaining_original_budget_without_sleep(monkeypatch):
    clock = iter([100.0, 100.0, 140.0])
    monkeypatch.setattr(speaking_planning, "monotonic", lambda: next(clock))
    timeouts = []
    async def recovering(settings, prompt, context, **kwargs):
        timeouts.append(kwargs["timeout_seconds"])
        result = proposals(context)
        if len(timeouts) == 1:
            result["candidates"][0]["targets"][0]["skip_when"] = None
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", recovering)
    create_plan()
    assert timeouts == [90.0, 50.0]


def test_exhausted_original_budget_does_not_start_corrective_call(monkeypatch):
    clock = iter([100.0, 100.0, 191.0])
    monkeypatch.setattr(speaking_planning, "monotonic", lambda: next(clock))
    calls = []
    async def expired(settings, prompt, context, **kwargs):
        calls.append(1)
        result = proposals(context)
        result["candidates"][0]["targets"][0]["skip_when"] = None
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", expired)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert response.headers["X-Speaking-Plan-Error"] == "timeout"
    assert len(calls) == 1
    assert not store.speaking_plans


@pytest.mark.parametrize("stall_attempt", [1, 2])
def test_outer_model_deadline_cancels_without_a_new_budget_or_sleep(monkeypatch, stall_attempt):
    # Allow local validation/logging to finish even under a concurrent build;
    # the deliberately stalled provider still exercises the outer deadline.
    monkeypatch.setattr(speaking_planning, "MODEL_BUDGET_SECONDS", 0.1)
    calls = []
    async def stalled(settings, prompt, context, **kwargs):
        calls.append(kwargs["timeout_seconds"])
        if len(calls) == stall_attempt:
            await asyncio.Future()
        result = proposals(context)
        result["candidates"][0]["targets"][0]["skip_when"] = None
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", stalled)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert response.headers["X-Speaking-Plan-Error"] == "timeout"
    assert len(calls) == stall_attempt
    assert all(0 < timeout <= 0.1 for timeout in calls)
    if stall_attempt == 2:
        assert calls[1] < calls[0]
    assert OWNER not in speaking_planning._PLANNING_OWNERS
    assert not store.speaking_plans


def test_unconfigured_provider_is_explicit_failure(monkeypatch):
    from app.services.speaking_teaching import request_analysis_json
    monkeypatch.setattr(speaking_planning, "request_analysis_json", request_analysis_json)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert not store.speaking_plans


def test_schema_diagnostics_are_correlated_and_exclude_private_inputs(monkeypatch, caplog):
    private_text = "private-user-phrase-and-provider-token"
    async def invalid(settings, prompt, context, **kwargs):
        assert private_text not in prompt
        result = proposals(context)
        result["candidates"][0][private_text] = private_text
        result["candidates"][0]["targets"][0]["skip_when"] = [private_text]
        return model_output(result, context), {"raw_content": private_text, "elapsed_ms": 12}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", invalid)
    with caplog.at_level(logging.WARNING, logger=speaking_planning.__name__):
        response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert response.json()["detail"] == speaking_planning.PLAN_INVALID_OUTPUT
    assert response.headers["X-Speaking-Plan-Error"] == "invalid_output_schema"
    records = [record for record in caplog.records if record.name == speaking_planning.__name__]
    diagnostic = json.loads(records[0].args[0])
    assert diagnostic["request_id"] == response.headers["X-Speaking-Plan-Request-ID"]
    assert len(diagnostic["request_id"]) == 32
    assert diagnostic["code"] == "invalid_output_schema"
    assert diagnostic["elapsed_ms"] == 12
    assert any("skip_when" in issue["path"] for issue in diagnostic["issues"])
    assert any("unknown_field" in issue["path"] for issue in diagnostic["issues"])
    assert private_text not in caplog.text + response.text
    assert [(json.loads(record.args[0])["attempt"], json.loads(record.args[0])["outcome"])
            for record in records] == [(1, "failed")]
    assert OWNER not in caplog.text
    assert not store.speaking_plans


@pytest.mark.parametrize("code,detail", [
    ("timeout", speaking_planning.PLAN_TIMEOUT),
    ("provider_transport_error", speaking_planning.PLAN_PROVIDER_UNAVAILABLE),
    ("provider_http_error", speaking_planning.PLAN_PROVIDER_UNAVAILABLE),
    ("rate_limit", speaking_planning.PLAN_PROVIDER_UNAVAILABLE),
    ("analyzer_response_incomplete", speaking_planning.PLAN_INVALID_OUTPUT),
])
def test_provider_failure_categories_keep_one_request_and_safe_diagnostics(monkeypatch, caplog, code, detail):
    from app.services.speaking_teaching import AnalysisProviderError
    calls = []
    async def failed(*args, **kwargs):
        calls.append(1)
        raise AnalysisProviderError({"error_type": code, "raw_content": "private-provider-body",
                                     "elapsed_ms": 42, "headers": {"Authorization": "private-provider-key"}})
    monkeypatch.setattr(speaking_planning, "request_analysis_json", failed)
    with caplog.at_level(logging.WARNING, logger=speaking_planning.__name__):
        response = client.post("/api/speaking/plans", json=request_body())
    assert len(calls) == 1
    assert response.status_code == 503
    assert response.json()["detail"] == detail
    assert response.headers["X-Speaking-Plan-Error"] == code
    assert "private-provider" not in caplog.text + response.text
    assert OWNER not in speaking_planning._PLANNING_OWNERS


@pytest.mark.parametrize("failure,code", [
    ("transport", "persistence_transport_error"),
    ("sql", "persistence_unavailable"),
    ("schema", "persistence_response_schema"),
])
def test_save_failures_are_distinct_from_generation_without_leaking_database_details(
    monkeypatch, caplog, failure, code,
):
    model_calls = []
    async def counted(*args, **kwargs):
        model_calls.append(1)
        return await generated(*args, **kwargs)
    monkeypatch.setattr(speaking_planning, "request_analysis_json", counted)
    def respond(request):
        if failure == "transport":
            raise httpx.ReadTimeout("private-server-url-and-key", request=request)
        if failure == "sql":
            return httpx.Response(400, json={"code": "23514", "message": "private-database-details"})
        return httpx.Response(200, json={"private-response-field": "private-response-value"})
    database = SupabaseRepository("https://example.supabase.co", "private-test-key")
    database._client.close()
    database._client = httpx.Client(base_url="https://example.supabase.co/rest/v1",
                                  transport=httpx.MockTransport(respond))
    monkeypatch.setattr(speaking_service, "get_speaking_repository", lambda: SpeakingRepository(database))
    try:
        with caplog.at_level(logging.WARNING, logger=speaking_planning.__name__):
            response = client.post("/api/speaking/plans", json=request_body())
        assert response.status_code == 503
        assert response.json()["detail"] == speaking_planning.PLAN_SAVE_UNAVAILABLE
        assert response.headers["X-Speaking-Plan-Error"] == code
        assert len(model_calls) == 1
        assert "private-" not in caplog.text + response.text
        assert not store.speaking_plans
        if failure == "sql":
            assert '"database_code": "23514"' in caplog.text
    finally:
        database._client.close()


@pytest.mark.parametrize("failure", ["timeout", "rate_limit", "unauthorized", "transport", "truncated", "bad_json"])
def test_actual_provider_failures_are_safe_and_retryable(monkeypatch, failure):
    from app.services import speaking_teaching
    settings = SimpleNamespace(ark_api_key="test-key", ark_model="test-model",
                               ark_base_url="https://provider.example")
    monkeypatch.setattr(speaking_planning, "get_settings", lambda: settings)
    monkeypatch.setattr(speaking_planning, "request_analysis_json", speaking_teaching.request_analysis_json)
    original_client = httpx.AsyncClient
    calls = []
    def respond(request):
        calls.append(1)
        if failure == "timeout":
            raise httpx.ReadTimeout("private endpoint credential", request=request)
        if failure == "transport":
            raise httpx.ConnectError("private endpoint credential", request=request)
        if failure == "rate_limit":
            return httpx.Response(429, json={"private": "provider error"})
        if failure == "unauthorized":
            return httpx.Response(401, json={"private": "provider error"})
        return httpx.Response(200, json={"choices": [{
            "finish_reason": "length" if failure == "truncated" else "stop",
            "message": {"content": "not json"},
        }]})
    def provider_client(**kwargs):
        assert 0 < kwargs["timeout"] <= 90
        return original_client(**kwargs, transport=httpx.MockTransport(respond))
    monkeypatch.setattr(speaking_teaching.httpx, "AsyncClient", provider_client)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert len(calls) == 1
    assert "private" not in response.text and "credential" not in response.text
    assert not store.speaking_plans
    assert OWNER not in speaking_planning._PLANNING_OWNERS


def test_provider_helper_honors_per_call_deadline_without_changing_default(monkeypatch):
    from app.services import speaking_teaching
    settings = SimpleNamespace(ark_api_key="test-key", ark_model="test-model",
                               ark_base_url="https://provider.example")
    original_client = httpx.AsyncClient
    async def slow(request):
        await asyncio.sleep(0.05)
        return httpx.Response(200, json={})
    monkeypatch.setattr(speaking_teaching.httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(slow)))
    with pytest.raises(speaking_teaching.AnalysisProviderError) as failure:
        asyncio.run(speaking_teaching.request_analysis_json(
            settings, "json", {}, prompt_version="test", timeout_seconds=0.001))
    assert failure.value.trace["error_type"] == "timeout"
    assert speaking_teaching.request_analysis_json.__kwdefaults__["timeout_seconds"] is None
    assert speaking_teaching.ANALYSIS_TIMEOUT_SECONDS == 12


def test_same_owner_has_only_one_inflight_generation(monkeypatch):
    started, release = Event(), Event()
    async def slow(settings, prompt, context, **kwargs):
        started.set()
        assert await asyncio.to_thread(release.wait, 3)
        return json.dumps(proposals(context)), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", slow)
    body = request_body()
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(client.post, "/api/speaking/plans", json=body)
        try:
            assert started.wait(2)
            repeated = client.post("/api/speaking/plans", json=body)
            assert repeated.status_code == 409
            assert "already running" in repeated.json()["detail"]
        finally:
            release.set()
        assert first.result(timeout=3).status_code == 201
    assert OWNER not in speaking_planning._PLANNING_OWNERS


def test_missing_metadata_stays_unknown_without_blocking_text_based_fit():
    item = saved(metadata=False)
    plan = create_plan([item])
    assert plan["candidates"][0]["targets"][0]["metadata_status"] == "unknown"
    assert plan["candidates"][0]["targets"][0]["fit"] == "high"
    session = client.post("/api/speaking/sessions", json=session_request(plan)).json()
    assert session["items"][0]["register"] is None
    assert session["items"][0]["scenario_tags"] == []
    assert session["items"][0]["pattern_family"] is None


@pytest.mark.parametrize("fit", ["unknown", "low"])
def test_primary_unknown_or_low_fit_is_visible_but_cannot_start(monkeypatch, fit):
    async def uncertain(settings, prompt, context, **kwargs):
        result = proposals(context)
        for candidate in result["candidates"]:
            candidate["targets"][0]["fit"] = fit
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", uncertain)
    plan = create_plan()
    response = client.post("/api/speaking/sessions", json=session_request(plan))
    assert response.status_code == 422
    assert not store.speaking_sessions


def test_corpus_change_during_generation_does_not_persist_stale_plan(monkeypatch):
    async def changing(settings, prompt, context, **kwargs):
        corpus_service.update_corpus_item(OWNER, context["targets"][0]["corpus_item_id"],
                                          CorpusItemUpdate(meaning="Changed meaning"))
        return json.dumps(proposals(context)), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", changing)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 409
    assert not store.speaking_plans


def test_changed_corpus_cannot_create_a_new_session_from_old_plan():
    item = saved()
    plan = create_plan([item])
    corpus_service.update_corpus_item(OWNER, item.id, CorpusItemUpdate(text="a changed expression"))
    response = client.post("/api/speaking/sessions", json=session_request(plan))
    assert response.status_code == 409
    assert not store.speaking_sessions


def test_frozen_metadata_and_target_mapping_survive_source_edit_delete_and_retry():
    item = saved()
    plan = create_plan([item])
    body = session_request(plan)
    response = client.post("/api/speaking/sessions", json=body)
    assert response.status_code == 201, response.text
    session = response.json()
    target = session["mission_plan"]["targets"][0]
    assert target["session_item_id"] == session["items"][0]["id"]
    assert session["items"][0]["register"] == "professional"
    assert session["items"][0]["scenario_tags"] == ["workplace", "disagreement"]
    assert session["items"][0]["usage_note"] == item.usage_context
    corpus_service.update_corpus_item(OWNER, item.id, CorpusItemUpdate(meaning="Later edit"))
    assert client.post("/api/speaking/sessions", json=body).json() == session
    store.corpus_items.pop(item.id)
    replay = client.post("/api/speaking/sessions", json=body).json()
    assert replay["id"] == session["id"]
    assert replay["items"][0]["corpus_item_id"] is None
    assert replay["items"][0]["text"] == item.text
    assert replay["mission_plan"] == session["mission_plan"]
    assert client.get(f"/api/speaking/sessions/{session['id']}").json() == replay


@pytest.mark.parametrize("change", [
    {"goal": "Invented goal"}, {"scenario_type": "everyday"},
    {"candidate_id": str(uuid4())}, {"plan_id": str(uuid4())},
])
def test_plan_selection_cannot_be_replaced_by_client(change):
    plan = create_plan()
    response = client.post("/api/speaking/sessions", json={**session_request(plan), **change})
    assert response.status_code in {404, 409}
    assert not store.speaking_sessions


def test_plan_and_candidate_are_a_pair_and_new_candidate_conflicts_on_replay():
    plan = create_plan()
    body = session_request(plan)
    for field in ["candidate_id", "plan_id"]:
        incomplete = {key: value for key, value in body.items() if key != field}
        assert client.post("/api/speaking/sessions", json=incomplete).status_code == 422
    assert client.post("/api/speaking/sessions", json=body).status_code == 201
    assert client.post("/api/speaking/sessions", json={
        **body, "candidate_id": plan["candidates"][1]["id"], "goal": plan["candidates"][1]["goal"],
    }).status_code == 409
    # The legacy path cannot accidentally replay a planned submission.
    assert client.post("/api/speaking/sessions", json={
        key: value for key, value in body.items() if key not in {"plan_id", "candidate_id"}
    }).status_code == 409


def test_concurrent_planned_retries_create_one_session():
    plan = create_plan()
    payload = SpeakingSessionCreate.model_validate(session_request(plan))
    with ThreadPoolExecutor(max_workers=5) as executor:
        sessions = list(executor.map(lambda _: speaking_service.create_speaking_session(OWNER, payload), range(10)))
    assert len({session.id for session in sessions}) == 1
    assert len(store.speaking_sessions) == 1
    assert len({str(session.mission_plan.targets[0].session_item_id) for session in sessions}) == 1


def test_durable_plan_and_session_rpc_do_not_trust_client_documents(monkeypatch):
    plan = create_plan()
    body = session_request(plan)
    session = client.post("/api/speaking/sessions", json=body).json()
    calls = []
    def respond(request):
        payload = json.loads(request.content)
        calls.append(request.url.path)
        assert payload["p_user_id"] == OWNER
        if request.url.path.endswith("create_evidence_speaking_loadout"):
            assert payload["p_plan_id"] == plan["id"]
            assert payload["p_candidate_id"] == plan["candidates"][0]["id"]
            assert payload["p_support_level"] is None and payload["p_evidence_contract_version"] is None
            assert "mission_plan" not in payload and "targets" not in payload
            return httpx.Response(200, json=session)
        if request.url.path.endswith("get_speaking_plan"):
            return httpx.Response(200, json=plan)
        assert request.url.path.endswith("save_speaking_plan")
        assert payload["p_corpus_snapshots"][0]["register"] == "professional"
        return httpx.Response(200, json=payload["p_plan"])
    database = SupabaseRepository("https://example.supabase.co", "test-key")
    database._client.close()
    database._client = httpx.Client(base_url="https://example.supabase.co/rest/v1",
                                  transport=httpx.MockTransport(respond))
    monkeypatch.setattr(speaking_service, "get_speaking_repository", lambda: SpeakingRepository(database))
    try:
        assert client.post("/api/speaking/sessions", json=body).json() == session
        assert client.get(f"/api/speaking/plans/{plan['id']}").json() == plan
        assert client.post("/api/speaking/plans", json=request_body()).status_code == 201
        assert len(calls) == 3
    finally:
        database._client.close()


@pytest.mark.parametrize("frame,expected", [
    (None, "missing_sentence_frame"),
    ("to be fair", "missing_slot"),
    ("to be fair, []", "empty_slot"),
    ("to be fair, [   ]", "empty_slot"),
    ("to be fair, [[point]]", "nested_slot"),
    ("to be fair, [unfinished", "invalid_slot_syntax"),
    ("to be fair, [two\nlines]", "invalid_slot_syntax"),
    ("fair enough, [point]", "changed_target_wording"),
    ("to be fair, [point]", None),
])
def test_frame_diagnostics_explain_existing_validation_without_private_wording(frame, expected):
    snapshot = {"kind": "chunk", "text": "to be fair"}
    assert speaking_planning._sentence_frame_issue(frame, snapshot) == expected
    assert speaking_planning._valid_sentence_frame(frame, snapshot) is (expected is None)
    assert speaking_planning._sentence_frame_issue("If [new label], then [result].", {
        "kind": "structure", "text": "If [condition], then [result]",
    }) == "changed_structure_frame"


@pytest.mark.parametrize("repair_succeeds", [True, False])
def test_semantic_repair_gets_every_failed_field_and_requirement_without_raw_output(
    monkeypatch, caplog, repair_succeeds,
):
    calls = []
    private_marker = "private-generated-value-do-not-log"
    expected_codes = {"plan_implicit_instruction_discloses_target", "plan_invalid_frame", "plan_duplicate_scenarios"}

    async def mixed_failures(settings, prompt, context, **kwargs):
        calls.append((prompt, copy.deepcopy(context), kwargs))
        if len(calls) == 2:
            repair = json.loads(prompt.rsplit("\n", 1)[-1])
            assert set(repair["requirements"]) == expected_codes
            assert len(repair["issues"]) == 9
            assert {issue["code"] for issue in repair["issues"]} == expected_codes
            for index in range(2):
                for field in ("communicative_function", "trigger_question", "skip_when", "sentence_frame"):
                    assert any(issue["path"] == ["candidates", index, "targets", 0, field]
                               for issue in repair["issues"])
            assert private_marker not in prompt
            assert "to be fair" not in prompt
            assert not store.speaking_plans
        result = proposals(context)
        if len(calls) == 1 or not repair_succeeds:
            for candidate in result["candidates"]:
                target = candidate["targets"][0]
                for field in ("communicative_function", "trigger_question", "skip_when"):
                    target[field] = f"{private_marker}: to be fair"
                target["sentence_frame"] = f"{private_marker} [point]"
            result["candidates"][1]["title"] = result["candidates"][0]["title"]
        return model_output(result, context), {"raw_content": private_marker}

    monkeypatch.setattr(speaking_planning, "request_analysis_json", mixed_failures)
    with caplog.at_level(logging.WARNING, logger=speaking_planning.__name__):
        response = client.post("/api/speaking/plans", json=request_body())
    assert len(calls) == 2
    assert calls[0][1]["targets"] == calls[1][1]["targets"]
    assert len(calls[1][1]["repair_tasks"]) == 9
    assert 0 < calls[1][2]["timeout_seconds"] < calls[0][2]["timeout_seconds"] <= 90
    assert response.status_code == (201 if repair_succeeds else 503)
    assert len(store.speaking_plans) == int(repair_succeeds)
    if not repair_succeeds:
        assert response.headers["X-Speaking-Plan-Error"] == "plan_implicit_instruction_discloses_target"
    diagnostics = [json.loads(record.args[0]) for record in caplog.records
                   if record.name == speaking_planning.__name__]
    assert len(diagnostics[0]["issues"]) == 9
    assert private_marker not in caplog.text + response.text
    assert "to be fair" not in caplog.text


def test_target_identity_failure_skips_unsafe_alignment_but_checks_other_candidates():
    from app.schemas.speaking_plan import SpeakingPlanCreate

    item = saved()
    payload = SpeakingPlanCreate.model_validate(request_body([item]))
    snapshots = [speaking_planning.corpus_plan_snapshot(item)]
    result = proposals({"targets": [{**snapshots[0], "role": "primary"}]})
    result["candidates"][0]["targets"][0].update(
        corpus_item_id=str(uuid4()), sentence_frame="Unmatched [point]",
        trigger_question="Could you say to be fair?",
    )
    result["candidates"][1]["targets"][0]["sentence_frame"] = "to be fair"
    with pytest.raises(speaking_planning._PlanContractError) as failure:
        speaking_planning._validate_proposals(json.dumps(result), payload, snapshots)
    assert failure.value.code == "plan_target_mismatch"
    assert failure.value.codes == ["plan_target_mismatch", "plan_invalid_frame"]
    assert failure.value.issues == [
        {"code": "plan_target_mismatch", "path": ["candidates", 0, "targets"], "type": "target_identity_or_role"},
        {"code": "plan_invalid_frame", "path": ["candidates", 1, "targets", 0, "sentence_frame"], "type": "missing_slot"},
    ]


def frame_template_proposals(text, kind, frame):
    from app.schemas.speaking_plan import SpeakingPlanCreate

    item_id = str(uuid4())
    snapshot = {"corpus_item_id": item_id, "text": text, "kind": kind,
                "register": None, "scenario_tags": [], "pattern_family": None}
    payload = SpeakingPlanCreate.model_validate({"scenario_type": "workplace", "targets": [
        {"corpus_item_id": item_id, "role": "primary"},
    ]})
    result = proposals({"targets": [{**snapshot, "role": "primary"}]})
    for candidate in result["candidates"]:
        candidate["targets"][0]["sentence_frame"] = frame
    return json.dumps(result), payload, [snapshot]


@pytest.mark.parametrize("text,kind,frame,expected", [
    ("eek out a beach head", "chunk", "We can {{target}} in [market].",
     "We can eek out a beach head in [market]."),
    ("A lot of light bulbs have come on over the last 90 days", "chunk",
     "{{target}} about [topic].", "A lot of light bulbs have come on over the last 90 days about [topic]."),
    ("That's where you get a foothold", "idiom", "{{target}}, by focusing on [customers].",
     "That's where you get a foothold, by focusing on [customers]."),
    ("pinch me moment.", "idiom", "[achievement] was a {{target}}",
     "[achievement] was a pinch me moment."),
    ("If [condition], then [result]", "structure", "{{target}}", "If [condition], then [result]"),
    ("eek out a beach head", "chunk", "We can eek out a beach head in [market].",
     "We can eek out a beach head in [market]."),
    ("If [condition], then [result]", "structure", "If [condition], then [result].",
     "If [condition], then [result]."),
])
def test_target_frame_templates_preserve_source_words_numbers_slots_and_legacy_literals(text, kind, frame, expected):
    raw, payload, snapshots = frame_template_proposals(text, kind, frame)
    result = speaking_planning._validate_proposals(raw, payload, snapshots)
    for candidate in result.candidates:
        assert candidate.targets[0].sentence_frame == expected
        assert speaking_planning._valid_sentence_frame(candidate.targets[0].sentence_frame, snapshots[0])
    assert "{{target}}" not in result.model_dump_json()
    assert snapshots[0]["text"] == text


@pytest.mark.parametrize("text,kind,frame", [
    ("eek out a beach head", "chunk", "{{target}} and {{target}} in [market]."),
    ("eek out a beach head", "chunk", "[{{target}}] in [market]."),
    ("eek out a beach head", "chunk", "{{{target}}} in [market]."),
    ("eek out a beach head", "chunk", "{{target}}"),
    ("If [condition], then [result]", "structure", "{{target}} with [another detail]."),
    ("x" * 495, "chunk", "{{target}} in [market]."),
])
def test_target_frame_templates_cannot_bypass_slots_structure_or_rendered_length(text, kind, frame):
    raw, payload, snapshots = frame_template_proposals(text, kind, frame)
    with pytest.raises(speaking_planning._PlanContractError) as failure:
        speaking_planning._validate_proposals(raw, payload, snapshots)
    assert failure.value.code == "plan_invalid_frame"
    assert len(failure.value.issues) == 2
    assert all(issue["code"] == "plan_invalid_frame" for issue in failure.value.issues)
