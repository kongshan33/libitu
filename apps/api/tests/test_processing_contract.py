from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Lock
from types import SimpleNamespace
import json

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.integrations.supabase_repository import SupabaseRepository
from app.schemas.content import ContentResolveResponse
from app.schemas.job import JobCreateRequest, ProcessingJob
from app.services import job_service as service, store


class AtomicJobs:
    """Shared-storage fixture; two callers have one atomic compare/update boundary."""
    def __init__(self, job=None):
        self.job, self.lock, self.accepted = job, Lock(), 0

    def find_job(self, *_):
        return self.job.model_copy(deep=True) if self.job else None

    def get_content(self, *_):
        return object()

    def create_job_once(self, job):
        with self.lock:
            if self.job is None:
                self.job = job
            return self.job

    def compare_and_swap_job(self, previous, updated):
        with self.lock:
            if (self.job.status, self.job.attempt_count) != (previous.status, previous.attempt_count):
                return None
            self.accepted += 1
            self.job = updated
            return updated


@pytest.fixture(params=["inline", "redis", "durable"])
def backend(request, monkeypatch):
    job = ProcessingJob(id="fixture-job", content_id="fixture-content", analysis_version="v1", status="failed", attempt_count=1)
    memory = AtomicJobs(job)
    enqueued = []
    monkeypatch.setattr(service, "get_settings", lambda: SimpleNamespace(queue_is_configured=request.param != "inline", analysis_version="v1"))
    monkeypatch.setattr(store, "jobs", {job.id: job})
    monkeypatch.setattr(store, "contents", {})
    monkeypatch.setattr(store, "content_transcripts", {})
    monkeypatch.setattr(service, "get_supabase_repository", lambda: memory if request.param == "durable" else None)
    for name in ("find_job", "create_job_once", "compare_and_swap_job", "get_content"):
        monkeypatch.setattr(service.processing_queue, name, getattr(memory, name))
    monkeypatch.setattr(service.processing_queue, "save_job", lambda _: None)
    monkeypatch.setattr(service.processing_queue, "enqueue", enqueued.append)
    return request.param, memory, enqueued


def ensure(**kwargs):
    return service.create_or_resume_job(JobCreateRequest(content_id="fixture-content", **kwargs))


def test_explicit_false_preserves_failure_and_never_enqueues(backend):
    _, _, enqueued = backend
    for _ in range(3):
        result = ensure(retry_failed=False)
        assert result.status == "failed" and result.attempt_count == 1
    assert not enqueued


def test_same_retry_intent_survives_concurrency_and_fast_second_failure(backend):
    mode, memory, _ = backend
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: ensure(retry_failed=True, expected_attempt_count=1), range(16)))
    assert {result.attempt_count for result in results} == {2}
    if mode != "inline":
        assert memory.accepted == 1
        memory.job = memory.job.model_copy(update={"status": "failed"})
    # Inline already failed because content is missing. A late repeat must not
    # turn the new failure into a third attempt.
    result = ensure(retry_failed=True, expected_attempt_count=1)
    assert result.status == "failed" and result.attempt_count == 2
    with pytest.raises(HTTPException) as error:
        ensure(retry_failed=True, expected_attempt_count=3)
    assert error.value.status_code == 409
    assert ensure(retry_failed=True, expected_attempt_count=2).attempt_count == 3


def test_legacy_omission_retains_adapter_retry_behavior(backend):
    mode, _, enqueued = backend
    result = ensure()
    assert result.status == ("failed" if mode == "inline" else "pending")
    assert bool(enqueued) == (mode != "inline")


def test_ensure_is_creation_idempotent_and_inline_can_complete(backend, monkeypatch):
    mode, memory, _ = backend
    memory.job = None
    store.jobs.clear()
    store.contents["fixture-content"] = ContentResolveResponse(content_id="fixture-content", kind="youtube", normalized_key="youtube:abcdefghijk")
    store.content_transcripts["fixture-content"] = "We practice."
    calls = []
    def build(*args):
        calls.append(True)
        return SimpleNamespace(id="blueprint")
    monkeypatch.setattr(service, "create_blueprint", build)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: ensure(retry_failed=False), range(16)))
    assert len({result.id for result in results}) == 1
    assert {result.attempt_count for result in results} == {1}
    assert len(calls) == (1 if mode == "inline" else 0)


def test_retry_request_validation_is_explicit():
    with TestClient(app) as client:
        for payload in ({"retry_failed": True}, {"retry_failed": False, "expected_attempt_count": 1},
                        {"retry_failed": True, "expected_attempt_count": -1},
                        {"retry_failed": True, "expected_attempt_count": True}):
            assert client.post("/api/jobs", json={"content_id": "fixture-content", **payload}).status_code == 422


def test_missing_content_is_404_for_new_ensure_and_failed_for_legacy(backend, monkeypatch):
    mode, memory, enqueued = backend
    memory.job = None
    store.jobs.clear()
    monkeypatch.setattr(memory, "get_content", lambda *_: None)
    monkeypatch.setattr(service.processing_queue, "get_content", lambda *_: None)
    with pytest.raises(HTTPException) as error:
        ensure(retry_failed=False)
    assert error.value.status_code == 404
    assert ensure().status == "failed"
    assert not enqueued


def test_retry_uses_durable_state_and_repairs_queue_gap(backend, monkeypatch):
    mode, memory, enqueued = backend
    if mode != "durable":
        return
    monkeypatch.setattr(service.processing_queue, "find_job", lambda *_: pytest.fail("Must read durable attempt"))
    def fail_publish(_):
        raise TimeoutError("PRIVATE")
    monkeypatch.setattr(service.processing_queue, "save_job", fail_publish)
    with pytest.raises(HTTPException) as error:
        ensure(retry_failed=True, expected_attempt_count=1)
    assert error.value.status_code == 503 and "PRIVATE" not in error.value.detail
    assert memory.job.attempt_count == 2 and memory.accepted == 1
    monkeypatch.setattr(service.processing_queue, "save_job", lambda _: None)
    assert ensure(retry_failed=True, expected_attempt_count=1).attempt_count == 2
    assert enqueued == [memory.job.id] and memory.accepted == 1


def test_repository_compare_update_filters_generation_state_and_identity():
    previous = ProcessingJob(id="job", content_id="content", analysis_version="v1", status="failed", attempt_count=5)
    updated = service._resume_job(previous)
    saved = None
    def respond(request):
        nonlocal saved
        assert request.method == "PATCH"
        assert dict(request.url.params) == {"id": "eq.job", "content_id": "eq.content", "analysis_version": "eq.v1",
                                            "status": "eq.failed", "attempt_count": "eq.5"}
        assert request.headers["Prefer"] == "return=representation"
        if saved:
            return httpx.Response(200, json=[])
        saved = json.loads(request.content)
        assert saved["status"] == "pending" and saved["attempt_count"] == 6
        return httpx.Response(200, json=[deepcopy(saved)])
    repo = SupabaseRepository("https://fixture.invalid", "fake")
    repo._client.close()
    repo._client = httpx.Client(base_url=repo._rest_url, transport=httpx.MockTransport(respond))
    try:
        assert repo.compare_and_swap_job(previous, updated).attempt_count == 6
        assert repo.compare_and_swap_job(previous, updated) is None
    finally:
        repo._client.close()
