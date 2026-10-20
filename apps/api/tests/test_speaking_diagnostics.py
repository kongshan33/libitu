"""Private teaching traces: isolation, immutable retries, terminal writes and pagination."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations import speaking_diagnostics_repository as repository
from app.integrations.speaking_runtime_repository import InlineRuntimeStore
from app.integrations.supabase_repository import SupabaseRepository
from app.main import app
from app.schemas.speaking import SpeakingSession
from app.services import speaking_diagnostics as diagnostics, store


@pytest.fixture
def mission():
    session = SpeakingSession(
        id=uuid4(), user_id="diagnostic-owner", client_id=uuid4(), scenario_type="workplace",
        goal="Agree on the next step", difficulty="standard", feedback_level="balanced",
        logic_template=None, created_at=datetime.now(timezone.utc), items=[],
    )
    session_id = str(session.id)
    store.speaking_sessions[session_id] = session
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=session.user_id)
    yield session.user_id, session_id
    app.dependency_overrides.clear()
    store.speaking_sessions.pop(session_id, None)
    repository.purge_inline_diagnostics(session_id)


def event(index=1, **payload):
    result = diagnostics.new_event("analysis.finished", {"revision": index, **payload})
    result["id"] = str(UUID(int=index))
    result["created_at"] = "2026-10-18T10:00:00+00:00"
    return result


def test_owner_isolation_immutable_retries_and_copy_boundaries(mission):
    owner, session_id = mission
    value = event(raw_response='{"evidence": []}')
    assert diagnostics.append_event(owner, session_id, value) is True
    assert diagnostics.append_event(owner, session_id, event(raw_response="changed")) is False
    value["payload"].clear()
    page = diagnostics.read_events(owner, session_id)
    assert page["events"][0]["payload"]["raw_response"] == '{"evidence": []}'
    page["events"][0]["payload"].clear()
    assert diagnostics.read_events(owner, session_id)["events"][0]["payload"]["revision"] == 1
    for call in [lambda: diagnostics.read_events("other", session_id),
                 lambda: diagnostics.append_event("other", session_id, event()),
                 lambda: diagnostics.read_events(owner, str(uuid4()))]:
        with pytest.raises(HTTPException) as error:
            call()
        assert error.value.status_code == 404


def test_concurrent_retries_append_once(mission):
    barrier = Barrier(8)

    def append(index):
        barrier.wait()
        return diagnostics.append_event(*mission, event(writer=index))

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(append, range(8)))
    assert results.count(True) == 1
    assert len(diagnostics.read_events(*mission)["events"]) == 1


def test_stable_exclusive_cursor_pages_equal_timestamps(mission):
    for index in [1, 4, 3, 2, 5]:
        diagnostics.append_event(*mission, event(index))
    first = diagnostics.read_events(*mission, limit=2)
    second = diagnostics.read_events(*mission, limit=2, before=first["next_before"])
    third = diagnostics.read_events(*mission, limit=2, before=second["next_before"])
    pages = first["events"] + second["events"] + third["events"]
    assert [item["payload"]["revision"] for item in pages] == [5, 4, 3, 2, 1]
    assert third["next_before"] is None
    assert first["limit"] == 2
    with pytest.raises(HTTPException) as error:
        diagnostics.read_events(*mission, before=str(uuid4()))
    assert error.value.status_code == 422


@pytest.mark.parametrize("status", ["completed", "abandoned"])
def test_terminal_analysis_trace_never_reopens_or_changes_runtime(mission, status):
    owner, session_id = mission
    runtime = InlineRuntimeStore()
    saved = runtime.compare_and_swap(owner, session_id, 0, {"messages": []}, status, 2)
    diagnostics.append_event(owner, session_id, event(outcome="completed_after_session_end"))
    assert runtime.read(owner, session_id) == saved
    assert len(diagnostics.read_events(owner, session_id)["events"]) == 1


def test_session_delete_cascades_diagnostics_and_late_append_cannot_resurrect(mission):
    owner, session_id = mission
    diagnostics.append_event(owner, session_id, event())
    runtime = InlineRuntimeStore()
    assert not runtime.delete("other", session_id)
    assert diagnostics.read_events(owner, session_id)["events"]
    assert runtime.delete(owner, session_id)
    assert session_id not in repository._inline_diagnostics_store._events
    for operation in [lambda: diagnostics.append_event(owner, session_id, event(2)),
                      lambda: diagnostics.read_events(owner, session_id)]:
        with pytest.raises(HTTPException) as error:
            operation()
        assert error.value.status_code == 404


def test_append_racing_delete_leaves_no_retained_trace(mission):
    barrier = Barrier(2)

    def append():
        barrier.wait()
        try:
            diagnostics.append_event(*mission, event())
        except HTTPException as error:
            assert error.status_code == 404

    def delete():
        barrier.wait()
        return InlineRuntimeStore().delete(*mission)

    with ThreadPoolExecutor(max_workers=2) as executor:
        appending, deleting = executor.submit(append), executor.submit(delete)
        appending.result()
        assert deleting.result()
    assert mission[1] not in repository._inline_diagnostics_store._events


def test_payload_limit_counts_utf8_bytes_and_does_not_truncate_trace(mission):
    value = event()
    overhead = len(json.dumps({"raw_response": ""}).encode())
    text = "界" * ((repository.MAX_PAYLOAD_BYTES - overhead) // 3)
    text += "x" * (repository.MAX_PAYLOAD_BYTES - overhead - len(text.encode()))
    value["payload"] = {"raw_response": text}
    assert diagnostics.append_event(*mission, value)
    value["id"] = str(uuid4())
    value["payload"]["raw_response"] += "x"
    with pytest.raises(HTTPException) as error:
        diagnostics.append_event(*mission, value)
    assert error.value.status_code == 422
    assert len(diagnostics.read_events(*mission)["events"]) == 1


@pytest.mark.parametrize("update", [
    {"id": "not-an-id"}, {"kind": ""}, {"kind": "x" * 81}, {"kind": "Raw Provider Error"},
    {"created_at": "yesterday"}, {"created_at": "2026-10-18T10:00:00"},
    {"payload": []}, {"payload": {"raw": float("nan")}}, {"payload": {1: "wrong"}},
    {"payload": {"text": "nul\x00"}}, {"payload": {"text": "\ud800"}},
    {"payload": {"nested": {"Authorization": "credential"}}},
    {"payload": {"runtime": {"ticket": "credential"}}}, {"unknown": "extra"},
])
def test_invalid_events_and_credentials_fail_closed(mission, update):
    with pytest.raises(HTTPException) as error:
        diagnostics.append_event(*mission, {**event(), **update})
    assert error.value.status_code == 422
    assert diagnostics.read_events(*mission)["events"] == []


@pytest.mark.parametrize("limit,before", [(0, None), (201, None), (True, None), (1, "bad")])
def test_invalid_page_bounds(mission, limit, before):
    with pytest.raises(HTTPException) as error:
        diagnostics.read_events(*mission, limit=limit, before=before)
    assert error.value.status_code == 422


def test_expired_traces_are_not_returned_and_cursor_requires_refresh(mission):
    diagnostics.append_event(*mission, event())
    saved = repository._inline_diagnostics_store._events[mission[1]][event()["id"]]
    saved["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert diagnostics.read_events(*mission)["events"] == []
    with pytest.raises(HTTPException) as error:
        diagnostics.read_events(*mission, before=event()["id"])
    assert error.value.status_code == 422


def test_private_api_authentication_owner_scope_and_pagination(mission):
    owner, session_id = mission
    client = TestClient(app)
    for index in [1, 2, 3]:
        diagnostics.append_event(owner, session_id, event(index))
    url = f"/api/speaking/sessions/{session_id}/diagnostics"
    response = client.get(url, params={"limit": 2})
    assert response.status_code == 200
    page = response.json()
    assert set(page) == {"events", "limit", "next_before"}
    assert len(page["events"]) == 2
    assert len(client.get(url, params={"before": page["next_before"]}).json()["events"]) == 1
    assert client.get(url, params={"limit": 201}).status_code == 422
    assert client.get(url, params={"before": "bad-id"}).status_code == 422
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="other-owner")
    assert client.get(url).status_code == 404
    app.dependency_overrides.clear()
    assert client.get(url).status_code == 401


@pytest.fixture
def database_factory():
    clients = []

    def create(handler):
        database = SupabaseRepository("https://example.supabase.co", "fixture-key")
        database._client.close()
        database._client = httpx.Client(
            base_url="https://example.supabase.co/rest/v1", transport=httpx.MockTransport(handler),
        )
        clients.append(database._client)
        return database

    yield create
    for client in clients:
        client.close()


def test_supabase_rpc_ownership_event_and_cursor_shapes(database_factory, mission):
    owner, session_id = mission
    saved = event()

    def respond(request):
        body = json.loads(request.content)
        assert request.method == "POST"
        assert body["p_user_id"] == owner and body["p_session_id"] == session_id
        if request.url.path.endswith("append_speaking_diagnostic"):
            assert body["p_event"] == saved
            return httpx.Response(200, json=True)
        assert request.url.path.endswith("read_speaking_diagnostics")
        assert body["p_limit"] == 2 and body["p_before"] == saved["id"]
        return httpx.Response(200, json={"events": [saved], "limit": 2, "next_before": None})

    adapter = repository.SupabaseDiagnosticsStore(database_factory(respond))
    assert adapter.append(owner, session_id, saved)
    assert adapter.read(owner, session_id, 2, saved["id"])["events"] == [saved]


@pytest.mark.parametrize("code,status", [("PT422", 422), ("42501", 503), ("23503", 503)])
def test_supabase_errors_are_sanitized_without_inline_fallback(database_factory, mission, code, status):
    adapter = repository.SupabaseDiagnosticsStore(database_factory(
        lambda _: httpx.Response(400, json={"code": code, "message": "private credential transcript"}),
    ))
    with pytest.raises(HTTPException) as error:
        adapter.append(*mission, event())
    assert error.value.status_code == status
    assert "credential" not in str(error.value)
    assert mission[1] not in repository._inline_diagnostics_store._events


@pytest.mark.parametrize("body", [
    [], {}, {"events": [], "limit": 200, "next_before": str(uuid4())},
    {"events": [{"private": "unexpected"}], "limit": 200, "next_before": None},
    {"events": [], "limit": 2, "next_before": None},
])
def test_bad_durable_pages_fail_closed(database_factory, mission, body):
    adapter = repository.SupabaseDiagnosticsStore(database_factory(lambda _: httpx.Response(200, json=body)))
    with pytest.raises(HTTPException) as error:
        adapter.read(*mission)
    assert error.value.status_code == 503


def test_configured_store_failure_never_falls_back_to_memory(monkeypatch):
    monkeypatch.setattr(repository, "get_supabase_repository", lambda: None)
    monkeypatch.setattr(repository, "get_settings", lambda: SimpleNamespace(
        supabase_server_is_configured=True, processing_mode="inline",
    ))
    with pytest.raises(HTTPException) as error:
        repository.get_diagnostics_store()
    assert error.value.status_code == 503
