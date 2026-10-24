import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations.speaking_repository import SpeakingRepository
from app.integrations.supabase_repository import SupabaseRepository
from app.main import app
from app.schemas.corpus import CorpusItemCreate, CorpusItemUpdate
from app.schemas.speaking import SpeakingSessionCreate
from app.services import corpus_service, speaking_service, store

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_loadout_state():
    store.speaking_sessions.clear()
    store.speaking_session_submissions.clear()
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="loadout-owner")
    yield
    app.dependency_overrides.clear()
    store.speaking_sessions.clear()
    store.speaking_session_submissions.clear()


def saved(kind="chunk", owner="loadout-owner", text="to be fair"):
    return corpus_service.create_corpus_item(owner, CorpusItemCreate(
        kind=kind, text=text, meaning="Acknowledge another view", tags=["softening"],
        slots={"point": "a view"} if kind == "structure" else {},
        source_locator={"source_title": "A useful source"},
    ))


def request_body(ids=None, **updates):
    body = {"client_id": str(uuid4()), "scenario_type": "workplace", "goal": "Agree on a deadline",
            "corpus_item_ids": [saved().id] if ids is None else ids}
    body.update(updates)
    return body


def test_options_are_public_and_match_the_selection_rules():
    app.dependency_overrides.clear()
    response = client.get("/api/speaking/options")
    assert response.status_code == 200
    options = response.json()
    assert (options["min_items"], options["max_structures"], options["max_expressions"]) == (1, 3, 5)
    assert [template["id"] for template in options["logic_templates"]] == [
        "persuasive_pitch", "technical_troubleshoot", "stakeholder_alignment",
        "status_update", "disagreement", "onboarding",
    ]
    assert options["logic_templates"][0]["steps"] == ["Context", "Tension", "Proposal", "Defend"]
    assert client.post("/api/speaking/sessions", json=request_body()).status_code == 401
    assert client.get(f"/api/speaking/sessions/{uuid4()}").status_code == 401


def test_selected_language_and_settings_round_trip_in_order():
    chunk, structure, idiom = saved(), saved("structure"), saved("idiom")
    body = request_body([idiom.id, structure.id, chunk.id], goal="  Agree on a deadline  ",
                        scenario_type="everyday", difficulty="challenging", feedback_level="detailed",
                        logic_template_id="disagreement")
    response = client.post("/api/speaking/sessions", json=body)
    assert response.status_code == 201
    session = response.json()
    assert session["goal"] == "Agree on a deadline"
    assert session["scenario_type"] == "everyday"
    assert session["difficulty"] == "challenging"
    assert session["feedback_level"] == "detailed"
    assert session["logic_template"]["id"] == "disagreement"
    assert session["status"] == "draft" and session["turn_count"] == 0
    assert session["user_id"] == "loadout-owner" and session["created_at"]
    assert [item["corpus_item_id"] for item in session["items"]] == [idiom.id, structure.id, chunk.id]
    assert [item["ordinal"] for item in session["items"]] == [0, 1, 2]
    assert [item["kind"] for item in session["items"]] == ["idiom", "structure", "chunk"]
    assert session["items"][0]["meaning"] == idiom.meaning
    assert session["items"][1]["slots"] == {"point": "a view"}
    assert session["items"][2]["source_title"] == "A useful source"
    assert client.get(f"/api/speaking/sessions/{session['id']}").json() == session


def test_one_item_and_no_logic_are_valid_with_defaults():
    response = client.post("/api/speaking/sessions", json=request_body())
    assert response.status_code == 201
    assert response.json()["logic_template"] is None
    assert response.json()["difficulty"] == "standard"
    assert response.json()["feedback_level"] == "balanced"
    assert response.json()["support_level"] is None


@pytest.mark.parametrize("level", ["model_frame", "model_label", "label_only", "no_hint"])
def test_support_level_round_trip_is_independent_of_difficulty(level):
    body = request_body(difficulty="guided", support_level=level)
    response = client.post("/api/speaking/sessions", json=body)
    assert response.status_code == 201
    session = response.json()
    assert session["support_level"] == level and session["difficulty"] == "guided"
    assert session["evidence_contract_version"] == "speaking-evidence-v3"
    assert session["items"][0]["source_corpus_item_id"] == body["corpus_item_ids"][0]
    assert client.get(f"/api/speaking/sessions/{session['id']}").json() == session
    assert client.post("/api/speaking/sessions", json=body).json() == session
    assert client.post("/api/speaking/sessions", json={**body, "support_level": None}).status_code == 409


def test_absent_and_null_support_preserve_legacy_retry_payload():
    body = request_body()
    original = client.post("/api/speaking/sessions", json=body).json()
    request, _ = store.speaking_session_submissions[("loadout-owner", body["client_id"])]
    assert "support_level" not in request
    assert original["evidence_contract_version"] is None
    assert original["items"][0]["source_corpus_item_id"] is None
    assert client.post("/api/speaking/sessions", json={**body, "support_level": None}).json() == original
    assert client.post("/api/speaking/sessions", json={**body, "support_level": "model_frame"}).status_code == 409


@pytest.mark.parametrize("updates", [
    {"client_id": "wrong"}, {"client_id": None}, {"goal": " \n\t "}, {"goal": "x" * 501},
    {"scenario_type": "daily_life"}, {"difficulty": "easy"}, {"feedback_level": "every_turn"},
    {"logic_template_id": "made_up"}, {"user_id": "someone-else"},
    {"support_level": "automatic"}, {"support_level": False},
    {"corpus_item_ids": []}, {"corpus_item_ids": ["blueprint-candidate"]},
])
def test_invalid_setup_returns_a_safe_string_without_creation(updates):
    response = client.post("/api/speaking/sessions", json=request_body(**updates))
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert store.speaking_sessions == {}


def test_duplicate_ids_and_missing_submission_id_are_rejected():
    item = saved()
    duplicate = request_body([item.id, item.id])
    assert client.post("/api/speaking/sessions", json=duplicate).status_code == 422
    del duplicate["client_id"]
    assert client.post("/api/speaking/sessions", json=duplicate).status_code == 422
    assert store.speaking_sessions == {}


@pytest.mark.parametrize("kinds,expected", [
    (["structure"] * 3 + ["chunk"] * 3 + ["idiom"] * 2, 201),
    (["structure"] * 4, 422), (["chunk"] * 4 + ["idiom"] * 2, 422),
    (["structure"] * 3 + ["chunk"] * 6, 422),
])
def test_limits_count_chunks_and_idioms_together(kinds, expected):
    response = client.post("/api/speaking/sessions", json=request_body([saved(kind).id for kind in kinds]))
    assert response.status_code == expected
    assert len(store.speaking_sessions) == int(expected == 201)


@pytest.mark.parametrize("use_other_owner", [False, True])
def test_unavailable_items_abort_the_entire_creation(use_other_owner):
    unavailable = saved(owner="loadout-other").id if use_other_owner else str(uuid4())
    response = client.post("/api/speaking/sessions", json=request_body([saved().id, unavailable]))
    assert response.status_code == 404
    assert isinstance(response.json()["detail"], str)
    assert store.speaking_sessions == {} and store.speaking_session_submissions == {}


def test_session_read_and_turn_cannot_cross_accounts():
    session = client.post("/api/speaking/sessions", json=request_body()).json()
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="loadout-other")
    assert client.get(f"/api/speaking/sessions/{session['id']}").status_code == 404
    assert client.post(f"/api/speaking/sessions/{session['id']}/turns", json={"user_message": "Hello"}).status_code == 404
    assert client.get(f"/api/speaking/sessions/{uuid4()}").status_code == 404
    assert client.get("/api/speaking/sessions/invalid").status_code == 422


def test_retries_keep_original_snapshot_after_source_edit_and_delete():
    item = saved()
    body = request_body([item.id], logic_template_id="persuasive_pitch")
    original = client.post("/api/speaking/sessions", json=body).json()
    corpus_service.update_corpus_item("loadout-owner", item.id, CorpusItemUpdate(text="Changed", tags=["changed"]))
    replay = client.post("/api/speaking/sessions", json=body)
    assert replay.status_code == 201 and replay.json() == original
    corpus_service.delete_corpus_item("loadout-owner", item.id)
    replay = client.post("/api/speaking/sessions", json=body).json()
    assert replay["id"] == original["id"]
    assert replay["items"][0] == {**original["items"][0], "corpus_item_id": None}
    assert client.get(f"/api/speaking/sessions/{original['id']}").json() == replay
    assert len(store.speaking_sessions) == 1


@pytest.mark.parametrize("change", [
    {"goal": "A different goal"}, {"difficulty": "guided"}, {"feedback_level": "light"},
    {"scenario_type": "everyday"}, {"logic_template_id": "onboarding"},
])
def test_same_client_id_with_different_request_conflicts(change):
    body = request_body()
    original = client.post("/api/speaking/sessions", json=body).json()
    response = client.post("/api/speaking/sessions", json={**body, **change})
    assert response.status_code == 409 and isinstance(response.json()["detail"], str)
    assert client.get(f"/api/speaking/sessions/{original['id']}").json() == original


def test_order_is_part_of_submission_and_owner_isolates_client_ids():
    body = request_body([saved().id, saved().id])
    original = client.post("/api/speaking/sessions", json=body).json()
    assert client.post("/api/speaking/sessions", json={**body, "corpus_item_ids": body["corpus_item_ids"][::-1]}).status_code == 409
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="loadout-other")
    other = client.post("/api/speaking/sessions", json={**body, "corpus_item_ids": [saved(owner="loadout-other").id]})
    assert other.status_code == 201 and other.json()["id"] != original["id"]


def test_concurrent_inline_retries_make_one_session():
    payload = SpeakingSessionCreate.model_validate(request_body())
    with ThreadPoolExecutor(max_workers=5) as executor:
        results = list(executor.map(lambda _: speaking_service.create_speaking_session("loadout-owner", payload), range(10)))
    assert len({result.id for result in results}) == 1
    assert len(store.speaking_sessions) == 1


def install_repository(monkeypatch, handler):
    database = SupabaseRepository("https://example.supabase.co", "test-key")
    database._client.close()
    database._client = httpx.Client(base_url="https://example.supabase.co/rest/v1", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(speaking_service, "get_speaking_repository", lambda: SpeakingRepository(database))
    return database


def test_durable_calls_use_one_atomic_rpc_with_verified_owner_and_server_logic(monkeypatch):
    body = request_body(logic_template_id="persuasive_pitch")
    document = client.post("/api/speaking/sessions", json=body).json()
    store.speaking_sessions.clear()
    calls = []

    def respond(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert payload["p_user_id"] == "loadout-owner" and request.method == "POST"
        if request.url.path.endswith("create_speaking_loadout"):
            assert "p_support_level" not in payload
            assert payload["p_client_id"] == body["client_id"]
            assert payload["p_corpus_item_ids"] == body["corpus_item_ids"]
            assert payload["p_logic_template"] == document["logic_template"]
        else:
            assert request.url.path.endswith("get_speaking_loadout") and payload["p_session_id"] == document["id"]
        return httpx.Response(200, json=document)

    database = install_repository(monkeypatch, respond)
    try:
        assert client.post("/api/speaking/sessions", json=body).json() == document
        assert len(calls) == 1
        assert client.get(f"/api/speaking/sessions/{document['id']}").json() == document
        assert store.speaking_sessions == {}
        assert client.post(f"/api/speaking/sessions/{document['id']}/turns", json={"user_message": "Hello"}).status_code == 501
        assert document["turn_count"] == 0
    finally:
        database._client.close()


@pytest.mark.parametrize("planned", [False, True])
def test_durable_support_uses_distinct_atomic_rpc(monkeypatch, planned):
    body = request_body(support_level="no_hint")
    document = client.post("/api/speaking/sessions", json=body).json()
    if planned:
        body.update(plan_id=str(uuid4()), candidate_id=str(uuid4()))
    calls = []
    def respond(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert request.url.path.endswith("/create_evidence_speaking_loadout")
        assert payload["p_support_level"] == "no_hint"
        assert payload["p_evidence_contract_version"] == "speaking-evidence-v3"
        assert payload["p_user_id"] == "loadout-owner"
        assert payload.get("p_plan_id") == body.get("plan_id")
        assert payload.get("p_candidate_id") == body.get("candidate_id")
        return httpx.Response(200, json=document)
    database = install_repository(monkeypatch, respond)
    try:
        response = client.post("/api/speaking/sessions", json=body)
        assert response.status_code == 201 and response.json() == document
        assert len(calls) == 1
    finally:
        database._client.close()


def test_missing_durable_session_stays_not_found(monkeypatch):
    database = install_repository(monkeypatch, lambda _: httpx.Response(200, text="null", headers={"content-type": "application/json"}))
    try:
        assert client.get(f"/api/speaking/sessions/{uuid4()}").status_code == 404
        assert client.post(f"/api/speaking/sessions/{uuid4()}/turns", json={"user_message": "Hi"}).status_code == 404
    finally:
        database._client.close()


@pytest.mark.parametrize("code,expected", [("PT404", 404), ("PT409", 409), ("PT422", 422), ("XX000", 503)])
def test_rpc_errors_have_safe_details_and_never_fall_back(monkeypatch, code, expected):
    body = request_body()
    database = install_repository(monkeypatch, lambda _: httpx.Response(400, json={"code": code, "message": "private sql and tokens"}))
    try:
        response = client.post("/api/speaking/sessions", json=body)
        assert response.status_code == expected and isinstance(response.json()["detail"], str)
        assert "private" not in response.json()["detail"] and store.speaking_sessions == {}
    finally:
        database._client.close()


@pytest.mark.parametrize("response_kind", ["network", "malformed", "html"])
def test_persistence_failure_does_not_report_in_memory_success(monkeypatch, response_kind):
    body = request_body()

    def respond(request):
        if response_kind == "network":
            raise httpx.ConnectError("private endpoint", request=request)
        if response_kind == "malformed":
            return httpx.Response(200, json={"unexpected": "private data"})
        return httpx.Response(502, text="upstream private error")

    database = install_repository(monkeypatch, respond)
    try:
        response = client.post("/api/speaking/sessions", json=body)
        assert response.status_code == 503
        assert "private" not in response.json()["detail"] and store.speaking_sessions == {}
    finally:
        database._client.close()


@pytest.mark.parametrize("mode,configured", [("queue", False), ("inline", True)])
def test_storage_configuration_never_silently_falls_back(monkeypatch, mode, configured):
    payload = SpeakingSessionCreate.model_validate(request_body())
    monkeypatch.setattr(speaking_service, "get_speaking_repository", lambda: None)
    monkeypatch.setattr(speaking_service, "get_settings", lambda: SimpleNamespace(
        processing_mode=mode, supabase_server_is_configured=configured,
    ))
    with pytest.raises(HTTPException) as error:
        speaking_service.create_speaking_session("loadout-owner", payload)
    assert error.value.status_code == 503 and store.speaking_sessions == {}
