"""Report API and worker lifecycle. No provider/database call is allowed here."""

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.main import app
from app.schemas.speaking import SpeakingSession
from app.schemas.speaking_feedback import ANALYSIS_VERSION, RUBRIC_VERSION, FeedbackResult
from app.services import speaking_feedback_service as service, speaking_runtime_state, store
from app.workers import speaking_feedback_worker as worker


def result():
    return FeedbackResult.model_validate({
        "dimensions": [{"id": key, "score": None, "basis": "coverage" if key == "transfer" else "ai_assessment",
                        "summary": "Insufficient evidence", "criteria": []}
                       for key in ("task_fit", "transfer", "scenario_fit", "naturalness")],
        "item_results": [], "statistics": {},
    })


@pytest.fixture
def mission(monkeypatch):
    now = datetime.now(timezone.utc).isoformat()
    session = SpeakingSession(id=uuid4(), user_id="feedback-service-owner", client_id=uuid4(),
                              scenario_type="workplace", goal="Agree on a next step", difficulty="standard",
                              feedback_level="balanced", logic_template=None, status="completed",
                              created_at=now, items=[])
    sid = str(session.id)
    store.speaking_sessions[sid] = session
    job = {"id": str(uuid4()), "session_id": sid, "status": "queued", "input_hash": "a" * 64,
           "rubric_version": RUBRIC_VERSION, "analysis_version": ANALYSIS_VERSION,
           "attempts": 0, "created_at": now, "updated_at": now, "lease_token": "PRIVATE-LEASE",
           "source": {"session": session.model_dump(mode="json"), "messages": [],
                      "controller": {"exposures": [{"private": "PRIVATE-CONTROLLER"}]}}, "result": None}

    class Repository:
        saved = job
        requested = []
        finished = []
        can_complete = True
        def read(self, owner, session_id):
            return deepcopy(self.saved)
        def enqueue(self, owner, session_id, retry=False):
            self.requested.append((owner, session_id, retry))
            return deepcopy(self.saved)
        def pending_sessions(self, limit=10):
            return [{"user_id": session.user_id, "session_id": sid}]
        def claim(self):
            return deepcopy(self.saved)
        def complete(self, job_id, token, status, value, error_code=None):
            self.finished.append((job_id, token, status, value, error_code))
            return self.can_complete
    repository = Repository()
    monkeypatch.setattr(service, "get_feedback_store", lambda: repository)
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=session.user_id)
    yield session, sid, repository
    store.speaking_sessions.pop(sid, None)
    app.dependency_overrides.clear()


def test_report_projection_keeps_nulls_and_excludes_private_fields(mission):
    session, sid, repo = mission
    repo.saved["result"] = result().model_dump(mode="json")
    value = service.read_feedback(session.user_id, sid).model_dump(mode="json")
    assert value["result"]["dimensions"][0]["score"] is None
    assert not {"source", "controller", "lease_token"}.intersection(value)
    assert "PRIVATE" not in str(value)


def test_get_does_not_enqueue_and_post_forwards_only_explicit_retry(mission):
    _, sid, repo = mission
    with TestClient(app) as client:
        assert client.get(f"/api/speaking/sessions/{sid}/feedback").status_code == 200
        assert repo.requested == []
        assert client.post(f"/api/speaking/sessions/{sid}/feedback", json={}).status_code == 200
        assert repo.requested[-1][2] is False
        assert client.post(f"/api/speaking/sessions/{sid}/feedback", json={"retry": True}).status_code == 200
        assert repo.requested[-1][2] is True
        assert client.post(f"/api/speaking/sessions/{sid}/feedback", json={"owner": "forged"}).status_code == 422


def test_foreign_and_missing_reports_do_not_reveal_state(mission):
    _, sid, repo = mission
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="other-owner")
    with TestClient(app) as client:
        for route in (sid, str(uuid4())):
            assert client.get(f"/api/speaking/sessions/{route}/feedback").status_code == 404
            assert client.post(f"/api/speaking/sessions/{route}/feedback", json={}).status_code == 404
    assert repo.requested == []


def test_active_session_cannot_request_or_read_final_report(mission):
    _, sid, repo = mission
    store.speaking_sessions[sid] = store.speaking_sessions[sid].model_copy(update={"status": "active"})
    with TestClient(app) as client:
        assert client.get(f"/api/speaking/sessions/{sid}/feedback").status_code == 409
        assert client.post(f"/api/speaking/sessions/{sid}/feedback", json={}).status_code == 409
    assert repo.requested == []


def test_missing_report_get_does_not_start_scoring(mission):
    _, sid, repo = mission
    repo.saved = None
    with TestClient(app) as client:
        assert client.get(f"/api/speaking/sessions/{sid}/feedback").status_code == 404
    assert repo.requested == []


@pytest.mark.parametrize("status,attempts,code,expected", [
    ("failed", 1, "assessment_failed", True), ("partial", 2, "assessment_incomplete", True),
    ("ready", 1, None, False), ("insufficient_data", 1, None, False),
    ("failed", 3, "assessment_failed", False), ("failed", 1, "worker_version_mismatch", False),
    ("partial", 1, "input_limit", False),
])
def test_retryability_is_bounded(mission, status, attempts, code, expected):
    _, _, repo = mission
    repo.saved.update(status=status, attempts=attempts, error_code=code)
    assert service.public_feedback(repo.saved).retryable is expected


def test_invalid_saved_public_result_is_sanitized(mission):
    _, _, repo = mission
    repo.saved["result"] = {"dimensions": "PRIVATE bad data"}
    with pytest.raises(HTTPException) as error:
        service.public_feedback(repo.saved)
    assert error.value.status_code == 503
    assert "PRIVATE" not in error.value.detail


def test_end_is_successful_when_enqueue_needs_recovery(mission, monkeypatch):
    from app.routers import speaking
    _, sid, _ = mission
    def unavailable(*args, **kwargs):
        raise HTTPException(503, "unavailable")
    monkeypatch.setattr(speaking, "request_feedback", unavailable)
    with TestClient(app) as client:
        ended = client.post(f"/api/speaking/sessions/{sid}/end")
    assert ended.status_code == 200
    assert ended.json()["session"]["status"] == "completed"


def test_worker_reconciles_end_gap_and_publishes_validated_result(mission, monkeypatch):
    _, _, repo = mission
    async def assess(source):
        return "partial", result()
    monkeypatch.setattr(worker, "assess_feedback", assess)
    assert asyncio.run(worker.run_once(repo))
    assert len(repo.requested) == 1
    _, token, status, value, code = repo.finished[0]
    assert token == "PRIVATE-LEASE" and status == "partial"
    assert value["dimensions"][0]["score"] is None and code == "assessment_incomplete"


def test_worker_stale_completion_cannot_publish(mission, monkeypatch):
    _, _, repo = mission
    repo.can_complete = False
    async def assess(source):
        return "ready", result()
    monkeypatch.setattr(worker, "assess_feedback", assess)
    assert asyncio.run(worker.process_job(repo, repo.saved)) is False


def test_worker_version_mismatch_never_calls_provider(mission, monkeypatch):
    _, _, repo = mission
    repo.saved["rubric_version"] = "future-rubric"
    async def forbidden(*args):
        pytest.fail("Version mismatch called provider")
    monkeypatch.setattr(worker, "assess_feedback", forbidden)
    asyncio.run(worker.process_job(repo, repo.saved))
    assert repo.finished[0][2:] == ("failed", None, "worker_version_mismatch")


def test_worker_exception_is_sanitized(mission, monkeypatch, caplog):
    _, _, repo = mission
    async def failed(*args):
        raise RuntimeError("PRIVATE provider body and request headers")
    monkeypatch.setattr(worker, "assess_feedback", failed)
    asyncio.run(worker.process_job(repo, repo.saved))
    assert repo.finished[0][2:] == ("failed", None, "assessment_failed")
    assert "PRIVATE" not in caplog.text


def test_worker_has_total_deadline(mission, monkeypatch):
    _, _, repo = mission
    async def hanging(*args):
        await asyncio.sleep(5)
    monkeypatch.setattr(worker, "assess_feedback", hanging)
    monkeypatch.setattr(worker, "DEADLINE_SECONDS", 0.005)
    asyncio.run(worker.process_job(repo, repo.saved))
    assert repo.finished[0][2:] == ("failed", None, "assessment_timeout")


def test_failed_retry_preserves_previous_validated_report(mission, monkeypatch):
    _, _, repo = mission
    previous = result()
    previous.dimensions[1].score = 50
    repo.saved["result"] = previous.model_dump(mode="json")
    async def failed(*args):
        raise TimeoutError
    monkeypatch.setattr(worker, "assess_feedback", failed)
    asyncio.run(worker.process_job(repo, repo.saved))
    assert repo.finished[0][2] == "failed"
    assert repo.finished[0][3]["dimensions"][1]["score"] == 50


def test_bad_reconciliation_source_does_not_starve_valid_jobs(mission):
    _, sid, repo = mission
    def pending(limit=10):
        return [{"user_id": "owner", "session_id": "bad"}, {"user_id": "owner", "session_id": sid}]
    def enqueue(owner, session_id):
        if session_id == "bad":
            raise HTTPException(503, "temporary")
        return repo.saved
    repo.pending_sessions, repo.enqueue = pending, enqueue
    assert worker.reconcile(repo) == 1


def test_report_cors_accepts_configured_web_origin_and_rejects_unknown_origin(mission):
    from fastapi.middleware.cors import CORSMiddleware
    _, sid, _ = mission
    allowed = next(row.kwargs["allow_origins"] for row in app.user_middleware if row.cls is CORSMiddleware)[0]
    with TestClient(app) as client:
        for origin, expected in ((allowed, 200), ("https://untrusted.invalid", 400)):
            response = client.options(f"/api/speaking/sessions/{sid}/feedback", headers={
                "Origin": origin, "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            })
            assert response.status_code == expected
            assert response.headers.get("access-control-allow-origin") == (origin if expected == 200 else None)
