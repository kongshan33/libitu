import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.integrations import speaking_runtime_repository as runtime
from app.integrations.supabase_repository import SupabaseRepository
from app.schemas.speaking import SpeakingSession
from app.services import store


@pytest.fixture
def fixture_session():
    session = SpeakingSession(
        id=uuid4(), user_id="runtime-owner", client_id=uuid4(), scenario_type="workplace",
        goal="Agree on the next step", difficulty="standard", feedback_level="balanced",
        logic_template=None, created_at=datetime.now(timezone.utc), items=[],
    )
    store.speaking_sessions[str(session.id)] = session
    yield str(session.id)
    store.speaking_sessions.pop(str(session.id), None)


def test_inline_default_owner_isolation_and_atomic_metadata(fixture_session):
    adapter = runtime.InlineRuntimeStore()
    assert adapter.read("runtime-owner", fixture_session) == {
        "version": 0, "document": {}, "status": "draft", "turn_count": 0,
    }
    assert adapter.read("other-owner", fixture_session) is None
    assert adapter.compare_and_swap("other-owner", fixture_session, 0, {}, "active", 1) is None
    assert adapter.delete("other-owner", fixture_session) is False
    assert adapter.read("runtime-owner", str(uuid4())) is None

    document = {"messages": [{"text": "We can move forward. 继续吧。"}], "policy": {"instruction": "private"}}
    result = adapter.compare_and_swap("runtime-owner", fixture_session, 0, document, "active", 1)
    assert result == {"version": 1, "document": document, "status": "active", "turn_count": 1}
    assert store.speaking_sessions[fixture_session].status == "active"
    assert store.speaking_sessions[fixture_session].turn_count == 1
    document["messages"].clear()
    result["document"]["policy"].clear()
    saved = adapter.read("runtime-owner", fixture_session)
    assert saved["document"]["messages"][0]["text"].endswith("继续吧。")
    assert saved["document"]["policy"] == {"instruction": "private"}
    saved["document"].clear()
    assert adapter.read("runtime-owner", fixture_session)["document"]


def test_concurrent_cas_has_exactly_one_winner(fixture_session):
    adapter = runtime.InlineRuntimeStore()
    barrier = Barrier(8)

    def write(index):
        barrier.wait()
        try:
            return adapter.compare_and_swap("runtime-owner", fixture_session, 0, {"winner": index}, "active", 1)
        except runtime.RuntimeConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(write, range(8)))
    assert results.count("conflict") == 7
    assert adapter.read("runtime-owner", fixture_session)["version"] == 1


@pytest.mark.parametrize("terminal", ["completed", "abandoned"])
def test_terminal_cannot_reopen_or_change_but_final_flush_is_allowed(fixture_session, terminal):
    adapter = runtime.InlineRuntimeStore()
    adapter.compare_and_swap("runtime-owner", fixture_session, 0, {"messages": []}, terminal, 1)
    for status in {"draft", "active", "completed", "abandoned"} - {terminal}:
        with pytest.raises(runtime.RuntimeConflict):
            adapter.compare_and_swap("runtime-owner", fixture_session, 1, {"wrong": True}, status, 9)
    with pytest.raises(runtime.RuntimeConflict):
        adapter.compare_and_swap("runtime-owner", fixture_session, 0, {}, terminal, 2)
    result = adapter.compare_and_swap("runtime-owner", fixture_session, 1, {"final": True}, terminal, 2)
    assert result == {"version": 2, "document": {"final": True}, "status": terminal, "turn_count": 2}


def test_delete_cascades_private_state_and_old_cas_cannot_resurrect(fixture_session):
    adapter = runtime.InlineRuntimeStore()
    adapter.compare_and_swap("runtime-owner", fixture_session, 0, {"secret": "text"}, "active", 1)
    assert adapter.delete("runtime-owner", fixture_session) is True
    assert fixture_session not in adapter._documents
    assert adapter.read("runtime-owner", fixture_session) is None
    assert adapter.compare_and_swap("runtime-owner", fixture_session, 1, {"secret": "late"}, "active", 2) is None
    assert adapter.delete("runtime-owner", fixture_session) is False
    assert fixture_session not in store.speaking_sessions


def test_delete_and_cas_are_serialized_without_resurrection(fixture_session):
    adapter = runtime.InlineRuntimeStore()
    barrier = Barrier(2)

    def write():
        barrier.wait()
        return adapter.compare_and_swap("runtime-owner", fixture_session, 0, {"final": True}, "active", 1)

    def delete():
        barrier.wait()
        return adapter.delete("runtime-owner", fixture_session)

    with ThreadPoolExecutor(max_workers=2) as executor:
        writing, deleting = executor.submit(write), executor.submit(delete)
        assert deleting.result() is True
        result = writing.result()
        assert result is None or result["version"] == 1
    assert adapter.read("runtime-owner", fixture_session) is None
    assert fixture_session not in adapter._documents


def test_document_limit_counts_utf8_bytes_and_accepts_exact_boundary(fixture_session):
    adapter = runtime.InlineRuntimeStore()
    overhead = len(json.dumps({"text": ""}).encode())
    text = "界" * ((runtime.MAX_DOCUMENT_BYTES - overhead) // 3)
    text += "x" * (runtime.MAX_DOCUMENT_BYTES - overhead - len(text.encode()))
    document = {"text": text}
    adapter.compare_and_swap("runtime-owner", fixture_session, 0, document, "active", 1)
    with pytest.raises(HTTPException) as exc:
        adapter.compare_and_swap("runtime-owner", fixture_session, 1, {"text": text + "x"}, "active", 2)
    assert exc.value.status_code == 422
    assert adapter.read("runtime-owner", fixture_session)["version"] == 1


@pytest.mark.parametrize("changes", [
    {"expected_version": -1}, {"expected_version": True}, {"expected_version": runtime.MAX_VERSION},
    {"document": []}, {"document": {"nan": float("nan")}}, {"document": {"inf": float("inf")}},
    {"document": {1: "integer key"}}, {"document": {"text": "nul\x00"}},
    {"document": {"text": "\ud800"}}, {"document": {"tuple": (1,)}},
    {"turn_count": -1}, {"turn_count": True}, {"turn_count": 2147483648}, {"status": "live"},
])
def test_invalid_mutations_do_not_change_state(fixture_session, changes):
    adapter = runtime.InlineRuntimeStore()
    args = {"expected_version": 0, "document": {}, "status": "active", "turn_count": 1, **changes}
    with pytest.raises(HTTPException) as exc:
        adapter.compare_and_swap("runtime-owner", fixture_session, **args)
    assert exc.value.status_code == 422 and isinstance(exc.value.detail, str)
    assert adapter.read("runtime-owner", fixture_session)["version"] == 0


@pytest.mark.parametrize("owner,session_id", [("", str(uuid4())), ("owner", "bad-id")])
def test_invalid_identity_is_safe(owner, session_id):
    with pytest.raises(HTTPException) as exc:
        runtime.InlineRuntimeStore().read(owner, session_id)
    assert exc.value.status_code == 422


@pytest.fixture
def database_factory():
    clients = []

    def create(handler):
        database = SupabaseRepository("https://example.supabase.co", "test-key")
        database._client.close()
        database._client = httpx.Client(
            base_url="https://example.supabase.co/rest/v1", transport=httpx.MockTransport(handler),
        )
        clients.append(database._client)
        return database

    yield create
    for client in clients:
        client.close()


def test_durable_rpc_shapes_owner_and_null_results(database_factory, fixture_session):
    calls = []
    result = {"version": 1, "document": {"messages": []}, "status": "active", "turn_count": 1}

    def respond(request):
        body = json.loads(request.content)
        calls.append(request.url.path)
        assert request.method == "POST" and body["p_user_id"] == "runtime-owner"
        assert body["p_session_id"] == fixture_session
        if request.url.path.endswith("cas_speaking_runtime"):
            assert body == {"p_user_id": "runtime-owner", "p_session_id": fixture_session,
                            "p_expected_version": 0, "p_document": {"messages": []},
                            "p_status": "active", "p_turn_count": 1}
            return httpx.Response(200, json=result)
        if request.url.path.endswith("delete_speaking_runtime"):
            return httpx.Response(200, json=True)
        assert request.url.path.endswith("read_speaking_runtime")
        return httpx.Response(200, text="null")

    adapter = runtime.SupabaseRuntimeStore(database_factory(respond))
    assert adapter.read("runtime-owner", fixture_session) is None
    assert adapter.compare_and_swap("runtime-owner", fixture_session, 0, {"messages": []}, "active", 1) == result
    assert adapter.delete("runtime-owner", fixture_session) is True
    assert len(calls) == 3


@pytest.mark.parametrize("http_status,code,expected", [
    (409, "PT409", runtime.RuntimeConflict), (422, "PT422", 422),
    (403, "42501", 503), (500, "database_internal", 503), (409, "23505", 503),
])
def test_durable_errors_are_sanitized_and_never_fallback(database_factory, fixture_session, http_status, code, expected):
    adapter = runtime.SupabaseRuntimeStore(database_factory(
        lambda _: httpx.Response(http_status, json={"code": code, "message": "private transcript and credential"}),
    ))
    with pytest.raises(runtime.RuntimeConflict if expected is runtime.RuntimeConflict else HTTPException) as exc:
        adapter.compare_and_swap("runtime-owner", fixture_session, 0, {}, "active", 1)
    if expected is not runtime.RuntimeConflict:
        assert exc.value.status_code == expected
    assert "private" not in str(exc.value) and "credential" not in str(exc.value)
    assert store.speaking_sessions[fixture_session].status == "draft"


@pytest.mark.parametrize("body", [
    {}, [], {"version": True, "document": {}, "status": "active", "turn_count": 1},
    {"version": 1, "document": [], "status": "active", "turn_count": 1},
    {"version": 1, "document": {}, "status": "wrong", "turn_count": 1},
    {"version": 1, "document": {}, "status": "active", "turn_count": -1},
])
def test_malformed_read_envelopes_fail_closed(database_factory, fixture_session, body):
    adapter = runtime.SupabaseRuntimeStore(database_factory(lambda _: httpx.Response(200, json=body)))
    with pytest.raises(HTTPException) as exc:
        adapter.read("runtime-owner", fixture_session)
    assert exc.value.status_code == 503


@pytest.mark.parametrize("operation", ["read", "delete", "compare_and_swap"])
def test_timeout_and_invalid_json_do_not_touch_inline_state(database_factory, fixture_session, operation):
    def timeout(request):
        raise httpx.ReadTimeout("private details", request=request)

    for handler in [timeout, lambda _: httpx.Response(200, text="not-json")]:
        adapter = runtime.SupabaseRuntimeStore(database_factory(handler))
        with pytest.raises(HTTPException) as exc:
            args = (0, {}, "active", 1) if operation == "compare_and_swap" else ()
            getattr(adapter, operation)("runtime-owner", fixture_session, *args)
        assert exc.value.status_code == 503
        assert store.speaking_sessions[fixture_session].status == "draft"


def test_only_explicit_unconfigured_inline_mode_uses_fixture(monkeypatch):
    monkeypatch.setattr(runtime, "get_supabase_repository", lambda: None)
    for configured, mode in [(False, "queue"), (True, "inline"), (True, "queue")]:
        monkeypatch.setattr(runtime, "get_settings", lambda: SimpleNamespace(
            supabase_server_is_configured=configured, processing_mode=mode,
        ))
        with pytest.raises(HTTPException) as exc:
            runtime.get_runtime_store()
        assert exc.value.status_code == 503
    monkeypatch.setattr(runtime, "get_settings", lambda: SimpleNamespace(
        supabase_server_is_configured=False, processing_mode="inline",
    ))
    assert isinstance(runtime.get_runtime_store(), runtime.InlineRuntimeStore)
    database = object()
    monkeypatch.setattr(runtime, "get_supabase_repository", lambda: database)
    assert runtime.get_runtime_store().database is database


def test_configured_adapter_construction_failure_is_safe_without_fallback(monkeypatch):
    def fail():
        raise ValueError("sensitive invalid database URL")

    monkeypatch.setattr(runtime, "get_supabase_repository", fail)
    with pytest.raises(HTTPException) as exc:
        runtime.get_runtime_store()
    assert exc.value.status_code == 503
    assert "sensitive" not in exc.value.detail
