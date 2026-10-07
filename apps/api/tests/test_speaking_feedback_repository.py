import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.integrations import speaking_feedback_repository as feedback
from app.integrations.speaking_runtime_repository import InlineRuntimeStore
from app.integrations.supabase_repository import SupabaseRepository
from app.schemas.speaking import SpeakingSession
from app.services import store


@pytest.fixture
def setup():
    now = [1000.0]
    runtime = InlineRuntimeStore()
    adapter = feedback.InlineFeedbackStore(runtime, clock=lambda: now[0])
    session = SpeakingSession(id=uuid4(), user_id="feedback-owner", client_id=uuid4(),
                              scenario_type="workplace", goal="Agree on next steps", difficulty="standard",
                              feedback_level="balanced", logic_template=None,
                              created_at=datetime.now(timezone.utc), items=[])
    sid = str(session.id)
    store.speaking_sessions[sid] = session
    runtime.compare_and_swap(session.user_id, sid, 0, {
        "runtime": {"ticket": "private"}, "policy": {"instruction": "private"},
        "messages": [{"id": "user1", "role": "user", "text": "One trade-off is cost.", "private": "secret"}],
        "evidence": [{"id": "e1", "quote": "trade-off", "private": "secret"}],
        "controller": {"instruction": "private", "exposures": [{"id": "hint1", "after_turn": 0, "secret": True}]},
    }, "completed", 1)
    yield adapter, runtime, sid, now
    store.speaking_sessions.pop(sid, None)


def test_owner_isolation_and_missing_session(setup):
    adapter, _, sid, _ = setup
    assert adapter.read("feedback-owner", sid) is None
    assert adapter.enqueue("other", sid) is None
    assert adapter.enqueue("feedback-owner", str(uuid4())) is None
    job = adapter.enqueue("feedback-owner", sid)
    assert job["status"] == "queued" and job["attempts"] == 0
    assert adapter.read("other", sid) is None
    assert adapter.read("feedback-owner", sid) == job


@pytest.mark.parametrize("status", ["draft", "active", "abandoned"])
def test_only_completed_sessions_can_enqueue(setup, status):
    adapter, _, sid, _ = setup
    store.speaking_sessions[sid] = store.speaking_sessions[sid].model_copy(update={"status": status})
    with pytest.raises(HTTPException) as exc:
        adapter.enqueue("feedback-owner", sid)
    assert exc.value.status_code == 409
    assert adapter._jobs == {}


def test_snapshot_is_allowlisted_frozen_and_deeply_copied(setup):
    adapter, runtime, sid, _ = setup
    job = adapter.enqueue("feedback-owner", sid)
    assert set(job["source"]) == {"session", "messages", "evidence", "controller"}
    assert "private" not in json.dumps(job["source"]) and "secret" not in json.dumps(job["source"])
    original = adapter.read("feedback-owner", sid)
    job["source"]["messages"].clear()
    runtime.compare_and_swap("feedback-owner", sid, 1, {"messages": [{"text": "late revision"}]}, "completed", 2)
    again = adapter.enqueue("feedback-owner", sid, retry=True)
    assert again == original
    assert len(again["input_hash"]) == 64
    again["source"]["session"]["goal"] = "changed"
    assert adapter.read("feedback-owner", sid) == original


def test_concurrent_enqueue_and_claim_have_one_winner(setup):
    adapter, _, sid, _ = setup
    barrier = Barrier(8)

    def enqueue(_):
        barrier.wait()
        return adapter.enqueue("feedback-owner", sid)

    with ThreadPoolExecutor(max_workers=8) as pool:
        jobs = list(pool.map(enqueue, range(8)))
    assert len({job["id"] for job in jobs}) == 1
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: adapter.claim(), range(8)))
    assert sum(job is not None for job in results) == 1
    assert adapter.read("feedback-owner", sid)["attempts"] == 1


def test_expiry_reclaims_with_new_token_and_fences_old_writes(setup):
    adapter, _, sid, now = setup
    original = adapter.enqueue("feedback-owner", sid)
    first = adapter.claim()
    assert adapter.claim() is None
    now[0] += feedback.LEASE_SECONDS
    assert adapter.complete(first["id"], first["lease_token"], "ready", {}) is False
    second = adapter.claim()
    assert second["lease_token"] != first["lease_token"] and second["attempts"] == 2
    assert second["source"] == original["source"]
    assert adapter.complete(first["id"], first["lease_token"], "ready", {}) is False
    assert adapter.complete(second["id"], second["lease_token"], "ready", {"score": 75}) is True
    assert adapter.complete(second["id"], second["lease_token"], "failed", None) is False
    done = adapter.enqueue("feedback-owner", sid, retry=True)
    assert done["status"] == "ready" and done["result"] == {"score": 75}
    assert adapter.claim() is None


@pytest.mark.parametrize("status,result", [("failed", None), ("partial", {"observed": 1})])
def test_retry_requires_explicit_request_preserves_source_and_caps_three(setup, status, result):
    adapter, _, sid, _ = setup
    original = adapter.enqueue("feedback-owner", sid)
    for attempt in range(1, 4):
        claimed = adapter.claim()
        assert claimed["attempts"] == attempt
        assert adapter.complete(claimed["id"], claimed["lease_token"], status, result, "model_unavailable")
        unchanged = adapter.enqueue("feedback-owner", sid)
        assert unchanged["status"] == status and adapter.claim() is None
        retried = adapter.enqueue("feedback-owner", sid, retry=True)
        assert retried["source"] == original["source"] and retried["input_hash"] == original["input_hash"]
        assert retried["result"] == result
        assert retried["status"] == ("queued" if attempt < 3 else status)
    assert adapter.claim() is None


def test_expired_third_attempt_is_terminal_without_fourth_call(setup):
    adapter, _, sid, now = setup
    adapter.enqueue("feedback-owner", sid)
    for attempt in range(1, 4):
        assert adapter.claim()["attempts"] == attempt
        now[0] += feedback.LEASE_SECONDS + 1
    assert adapter.claim() is None
    job = adapter.enqueue("feedback-owner", sid, retry=True)
    assert job["status"] == "failed" and job["error_code"] == "retry_limit_reached"
    assert job["lease_token"] is None


def test_insufficient_data_is_terminal_and_not_retryable(setup):
    adapter, _, sid, _ = setup
    adapter.enqueue("feedback-owner", sid)
    job = adapter.claim()
    assert adapter.complete(job["id"], job["lease_token"], "insufficient_data", {})
    assert adapter.enqueue("feedback-owner", sid, retry=True)["status"] == "insufficient_data"


def test_delete_cascades_fixture_and_late_worker_cannot_recreate(setup):
    adapter, runtime, sid, _ = setup
    adapter.enqueue("feedback-owner", sid)
    claimed = adapter.claim()
    assert runtime.delete("feedback-owner", sid)
    assert adapter.complete(claimed["id"], claimed["lease_token"], "ready", {}) is False
    assert adapter.read("feedback-owner", sid) is None
    assert adapter.enqueue("feedback-owner", sid) is None
    assert sid not in adapter._jobs


def test_claim_filter_does_not_take_other_jobs(setup):
    adapter, _, sid, _ = setup
    job = adapter.enqueue("feedback-owner", sid)
    assert adapter.claim(str(uuid4())) is None
    assert adapter.read("feedback-owner", sid)["attempts"] == 0
    assert adapter.claim(job["id"])["id"] == job["id"]


def test_reconciliation_only_finds_completed_runtime_sessions(setup):
    adapter, _, sid, _ = setup
    assert {"session_id": sid, "user_id": "feedback-owner"} in adapter.pending_sessions()
    adapter.enqueue("feedback-owner", sid)
    assert all(row["session_id"] != sid for row in adapter.pending_sessions())


@pytest.mark.parametrize("result", [{"large": "界" * 400000}, {"bad": float("nan")}, {"bad": "nul\x00"}, {"bad": "\ud800"}])
def test_invalid_result_never_mutates_processing_job(setup, result):
    adapter, _, sid, _ = setup
    adapter.enqueue("feedback-owner", sid)
    job = adapter.claim()
    with pytest.raises(HTTPException) as exc:
        adapter.complete(job["id"], job["lease_token"], "ready", result)
    assert exc.value.status_code == 422
    assert adapter.read("feedback-owner", sid)["status"] == "processing"


@pytest.mark.parametrize("status,result,error", [("queued", {}, None), ("ready", None, None), ("ready", {}, "Provider secret details")])
def test_invalid_completion_is_safe(setup, status, result, error):
    adapter, _, sid, _ = setup
    adapter.enqueue("feedback-owner", sid)
    job = adapter.claim()
    with pytest.raises(HTTPException) as exc:
        adapter.complete(job["id"], job["lease_token"], status, result, error)
    assert exc.value.status_code == 422
    assert "secret" not in exc.value.detail


def test_oversized_source_not_enqueued(setup):
    adapter, runtime, sid, _ = setup
    # The fixture intentionally bypasses runtime validation to exercise snapshot bounds.
    runtime._documents[sid]["document"]["messages"] = [{"text": "x" * feedback.MAX_SOURCE_BYTES}]
    with pytest.raises(HTTPException) as exc:
        adapter.enqueue("feedback-owner", sid)
    assert exc.value.status_code == 422 and not adapter._jobs


@pytest.fixture
def database_factory():
    clients = []
    def create(handler):
        db = SupabaseRepository("https://example.supabase.co", "test-key")
        db._client.close()
        db._client = httpx.Client(base_url="https://example.supabase.co/rest/v1", transport=httpx.MockTransport(handler))
        clients.append(db._client)
        return db
    yield create
    for client in clients:
        client.close()


def test_rpc_contracts_and_deep_copy(database_factory, setup):
    inline, _, sid, _ = setup
    job = inline.enqueue("feedback-owner", sid)
    calls = []
    def respond(request):
        body = json.loads(request.content)
        calls.append((request.url.path.rsplit("/", 1)[-1], body))
        if request.url.path.endswith("complete_speaking_feedback"):
            return httpx.Response(200, json=True)
        if request.url.path.endswith("pending_speaking_feedback_sessions"):
            return httpx.Response(200, json=[{"user_id": "feedback-owner", "session_id": sid}])
        return httpx.Response(200, json=job)
    adapter = feedback.SupabaseFeedbackStore(database_factory(respond))
    assert adapter.enqueue("feedback-owner", sid) == job
    assert adapter.read("feedback-owner", sid) == job
    assert adapter.claim(job["id"]) == job
    assert adapter.complete(job["id"], str(uuid4()), "ready", {})
    assert adapter.pending_sessions(1) == [{"user_id": "feedback-owner", "session_id": sid}]
    assert calls[0] == ("enqueue_speaking_feedback", {"p_user_id": "feedback-owner", "p_session_id": sid, "p_retry": False})
    assert calls[2] == ("claim_speaking_feedback", {"p_job_id": job["id"]})


@pytest.mark.parametrize("status,code,expected", [(409,"PT409",409),(422,"PT422",422),(500,"secret",503),(403,"42501",503)])
def test_rpc_errors_sanitized_never_fallback(database_factory, setup, status, code, expected):
    _, _, sid, _ = setup
    adapter = feedback.SupabaseFeedbackStore(database_factory(lambda _: httpx.Response(
        status, json={"code": code, "message": "private transcript with credential"})))
    with pytest.raises(HTTPException) as exc:
        adapter.enqueue("feedback-owner", sid)
    assert exc.value.status_code == expected and "private" not in exc.value.detail


@pytest.mark.parametrize("value", [{}, [], {"status":"queued", "attempts":True}, "invalid"])
def test_malformed_rpc_job_fails_closed(database_factory, setup, value):
    _, _, sid, _ = setup
    adapter = feedback.SupabaseFeedbackStore(database_factory(lambda _: httpx.Response(200, json=value)))
    with pytest.raises(HTTPException) as exc:
        adapter.read("feedback-owner", sid)
    assert exc.value.status_code == 503


def test_transport_failures_are_sanitized(database_factory, setup):
    _, _, sid, _ = setup
    def timeout(request):
        raise httpx.ReadTimeout("secret", request=request)
    for handler in [timeout, lambda _: httpx.Response(200, text="not json")]:
        adapter = feedback.SupabaseFeedbackStore(database_factory(handler))
        with pytest.raises(HTTPException) as exc:
            adapter.read("feedback-owner", sid)
        assert exc.value.status_code == 503 and "secret" not in exc.value.detail


def test_only_unconfigured_inline_mode_falls_back(monkeypatch):
    monkeypatch.setattr(feedback, "get_supabase_repository", lambda: None)
    for configured, mode in [(True, "inline"), (False, "queue"), (True, "queue")]:
        monkeypatch.setattr(feedback, "get_settings", lambda: SimpleNamespace(
            supabase_server_is_configured=configured, processing_mode=mode))
        with pytest.raises(HTTPException) as exc:
            feedback.get_feedback_store()
        assert exc.value.status_code == 503
    monkeypatch.setattr(feedback, "get_settings", lambda: SimpleNamespace(
        supabase_server_is_configured=False, processing_mode="inline"))
    assert isinstance(feedback.get_feedback_store(), feedback.InlineFeedbackStore)


def test_snapshot_room_includes_loadout_beyond_runtime_limit(setup):
    adapter, runtime, sid, _ = setup
    runtime._documents[sid]["document"]["messages"] = [{"text": "x" * (1024 * 1024)}]
    job = adapter.enqueue("feedback-owner", sid)
    assert len(json.dumps(job["source"])) > 1024 * 1024
    assert job["status"] == "queued"


@pytest.mark.parametrize("error_code", ["input_limit", "worker_version_mismatch"])
def test_immutable_input_and_worker_version_failures_are_not_retryable(setup, error_code):
    adapter, _, sid, _ = setup
    adapter.enqueue("feedback-owner", sid)
    job = adapter.claim()
    assert adapter.complete(job["id"], job["lease_token"], "failed", None, error_code)
    unchanged = adapter.enqueue("feedback-owner", sid, retry=True)
    assert unchanged["status"] == "failed" and unchanged["attempts"] == 1
    assert adapter.claim() is None


def test_saved_version_strings_remain_readable_for_worker_compatibility_checks(database_factory, setup):
    inline, _, sid, _ = setup
    saved = inline.enqueue("feedback-owner", sid)
    saved["rubric_version"] = "speaking-rubric-v2"
    saved["analysis_version"] = "speaking-feedback-v0"
    adapter = feedback.SupabaseFeedbackStore(database_factory(lambda _: httpx.Response(200, json=saved)))
    assert adapter.read("feedback-owner", sid) == saved


@pytest.mark.parametrize("limit", [0, 101, True, "10"])
def test_reconciliation_limits_are_bounded_before_rpc(database_factory, limit):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=[])
    adapter = feedback.SupabaseFeedbackStore(database_factory(handler))
    with pytest.raises(HTTPException) as exc:
        adapter.pending_sessions(limit)
    assert exc.value.status_code == 422 and not calls
