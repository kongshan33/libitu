import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services import speaking_lifecycle as service
from app.services import practice_analysis_service as analysis
from app.schemas.job import ProcessingJob
from app.workers import blueprint_worker as worker


@pytest.mark.parametrize("failure", [None, "cleanup", "feedback"])
def test_end_commits_before_cleanup_and_enqueue_even_if_followup_fails(monkeypatch, failure, caplog):
    events = []
    result = object()
    receipts = {"runtime_id": "current-runtime", "exposures": {}, "presentations": {}}
    async def capture(owner, session_id):
        assert (owner, session_id) == ("owner", "session")
        events.append("capture_receipts")
        return receipts
    def end(owner, session_id, captured):
        assert (owner, session_id) == ("owner", "session")
        assert captured is receipts
        events.append("durable_end")
        return result
    async def stop(*args):
        events.append("cleanup")
        if failure == "cleanup":
            raise RuntimeError("PRIVATE")
    def feedback(*args):
        events.append("feedback")
        if failure == "feedback":
            raise RuntimeError("PRIVATE")
    monkeypatch.setattr(service, "capture_local_receipts", capture)
    monkeypatch.setattr(service.speaking_runtime_state, "end_session", end)
    monkeypatch.setattr(service, "stop_local", stop)
    monkeypatch.setattr(service, "request_feedback", feedback)
    assert asyncio.run(service.end_speaking_session("owner", "session")) is result
    assert events == ["capture_receipts", "durable_end", "cleanup", "feedback"]
    assert "PRIVATE" not in caplog.text


def test_durable_end_failure_has_no_local_cleanup_or_feedback(monkeypatch):
    events = []
    async def capture(*args):
        events.append("capture_receipts")
        return None
    def fail(owner, session_id, receipts):
        assert (owner, session_id, receipts) == ("owner", "session", None)
        events.append("durable_end")
        raise HTTPException(503, "Commit failed")
    async def unexpected(*args):
        pytest.fail("Do not clean before durable completion")
    monkeypatch.setattr(service, "capture_local_receipts", capture)
    monkeypatch.setattr(service.speaking_runtime_state, "end_session", fail)
    monkeypatch.setattr(service, "stop_local", unexpected)
    monkeypatch.setattr(service, "request_feedback", lambda *_: pytest.fail("Must not enqueue"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(service.end_speaking_session("owner", "session"))
    assert error.value.status_code == 503 and error.value.detail == "Commit failed"
    assert events == ["capture_receipts", "durable_end"]


def test_receipt_capture_failure_never_ends_cleans_or_enqueues(monkeypatch):
    async def fail(*args):
        raise HTTPException(503, "Receipt read unavailable")
    async def unexpected(*args):
        pytest.fail("Must not clean after failed receipt capture")
    monkeypatch.setattr(service, "capture_local_receipts", fail)
    monkeypatch.setattr(service.speaking_runtime_state, "end_session", lambda *_: pytest.fail("Must not freeze"))
    monkeypatch.setattr(service, "stop_local", unexpected)
    monkeypatch.setattr(service, "request_feedback", lambda *_: pytest.fail("Must not enqueue"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(service.end_speaking_session("owner", "session"))
    assert error.value.status_code == 503 and error.value.detail == "Receipt read unavailable"


def test_delete_tombstone_precedes_best_effort_cleanup(monkeypatch):
    events = []
    monkeypatch.setattr(service.speaking_runtime_state, "delete_session", lambda *_: events.append("delete"))
    async def stop(*args):
        events.append("stop")
        raise RuntimeError("Connection cleanup failed")
    monkeypatch.setattr(service, "stop_local", stop)
    asyncio.run(service.delete_speaking_session("owner", "session"))
    assert events == ["delete", "stop"]


def test_practice_tombstone_commits_before_failed_audio_cleanup(monkeypatch):
    events = []
    row = {"id": "attempt"}
    monkeypatch.setattr(analysis, "owned", lambda *_: row)
    def control(*args):
        events.append("tombstone")
        return {**row, "state": "deleted"}
    def remove(*args):
        events.append("audio")
        raise OSError("Storage unavailable")
    repo = SimpleNamespace(control=control, remove_audio=remove)
    with pytest.raises(OSError):
        analysis.delete(repo, "owner", "attempt")
    assert events == ["tombstone", "audio"]


@pytest.mark.parametrize("terminal", ["ready", "failed"])
def test_worker_rechecks_terminal_state_after_lock(monkeypatch, terminal):
    events = []
    job = ProcessingJob(id="job", content_id="content", analysis_version="v1", status=terminal, attempt_count=2)
    monkeypatch.setattr(worker.processing_queue, "acquire_lock", lambda _: events.append("lock") or True)
    monkeypatch.setattr(worker.processing_queue, "get_job", lambda _: events.append("read") or job)
    monkeypatch.setattr(worker.processing_queue, "release_lock", lambda _: events.append("release"))
    monkeypatch.setattr(worker.processing_queue, "save_job", lambda _: pytest.fail("Terminal jobs cannot restart"))
    worker.process_job("job", analyzer=lambda *_: pytest.fail("No analysis"))
    assert events == ["lock", "read", "release"]


def test_worker_cannot_publish_an_old_attempt_over_durable_retry(monkeypatch):
    stale = ProcessingJob(id="job", content_id="content", analysis_version="v1", status="failed", attempt_count=2)
    current = stale.model_copy(update={"status": "pending", "attempt_count": 3})
    repo = SimpleNamespace(get_job=lambda _: current,
        compare_and_swap_job=lambda *_: pytest.fail("Stale generation must not publish"))
    monkeypatch.setattr(worker, "get_supabase_repository", lambda: repo)
    monkeypatch.setattr(worker.processing_queue, "save_job", lambda _: pytest.fail("No stale cache publish"))
    with pytest.raises(worker.JobSuperseded):
        worker._save_job(stale)
