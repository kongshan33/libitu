from types import SimpleNamespace
from pathlib import Path
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.integrations.supabase_repository import SupabaseRepository
from app.schemas.content import ContentResolveResponse, ContentContext
from app.schemas.job import ProcessingJob
from app.services import content_context as service, store


def test_shared_web_api_contract_fixture():
    fixture = json.loads((Path(__file__).resolve().parents[3] / "packages/types/fixtures/content-context.json").read_text())
    assert ContentContext.model_validate(fixture).model_dump(mode="json") == fixture


@pytest.fixture
def source(monkeypatch):
    content = ContentResolveResponse(content_id="context-content", kind="youtube", normalized_key="youtube:abcdefghijk",
                                     source_url="https://youtu.be/abcdefghijk?tracking=discard", title=None)
    for name in ("contents", "jobs", "blueprints"):
        monkeypatch.setattr(store, name, {})
    store.contents[content.content_id] = content
    return content


def test_get_is_a_whitelisted_read_without_resolve_jobs_or_payload(source, monkeypatch):
    from app.services import content_resolver, job_service
    def forbidden(*args, **kwargs):
        pytest.fail("A read must not resolve, ensure or enqueue")
    monkeypatch.setattr(content_resolver, "resolve_content", forbidden)
    monkeypatch.setattr(job_service, "create_or_resume_job", forbidden)
    monkeypatch.setattr(service.processing_queue, "enqueue", forbidden)
    store.jobs["job"] = ProcessingJob(id="job", content_id=source.content_id, analysis_version=service.get_settings().analysis_version,
        status="failed", attempt_count=3, error_message="PRIVATE", error_code="private_code")
    with TestClient(app) as client:
        for _ in range(2):
            response = client.get(f"/api/content/{source.content_id}")
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store"
            body = response.json()
            assert body["content"] == {"content_id": source.content_id, "kind": "youtube",
                "source_url": "https://www.youtube.com/watch?v=abcdefghijk", "title": None, "language": None}
            assert set(body["processing"]["job"]) == {"id", "content_id", "analysis_version", "status", "attempt_count"}
            assert "PRIVATE" not in response.text
    assert store.jobs["job"].attempt_count == 3


def test_current_blueprint_is_independent_of_old_failed_job(source):
    version = service.get_settings().analysis_version
    store.jobs["old"] = ProcessingJob(id="old", content_id=source.content_id, analysis_version="old-version", status="failed")
    store.blueprints[source.content_id] = SimpleNamespace(content_id=source.content_id, analysis_version=version)
    context = service.read_content_context(source.content_id)
    assert context.processing.blueprint_available and context.processing.job is None
    store.blueprints[source.content_id].analysis_version = "old-version"
    assert not service.read_content_context(source.content_id).processing.blueprint_available


@pytest.mark.parametrize("kind", ["article", "pasted_text"])
def test_other_content_kinds_are_not_public_context(source, kind):
    store.contents[source.content_id] = source.model_copy(update={"kind": kind})
    with TestClient(app) as client:
        assert client.get(f"/api/content/{source.content_id}").status_code == 404
        assert client.get("/api/content/missing").status_code == 404


@pytest.mark.parametrize("source_url,key,expected", [
    (None, "youtube:abcdefghijk", 200), (None, "youtube:broken", 422),
    ("https://evil.test/watch?v=abcdefghijk", "youtube:abcdefghijk", 422),
    ("https://user:password@youtube.com/watch?v=abcdefghijk", "youtube:abcdefghijk", 422),
    ("https://youtube.com/evil?v=abcdefghijk", "youtube:abcdefghijk", 422),
    ("https://youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv", "youtube:abcdefghijk", 422),
    ("https://youtube.com/watch?v=lmnopqrstuv", "youtube:abcdefghijk", 422),
])
def test_source_metadata_recovery_and_conflicts(source, source_url, key, expected):
    store.contents[source.content_id] = source.model_copy(update={"source_url": source_url, "normalized_key": key})
    with TestClient(app) as client:
        response = client.get(f"/api/content/{source.content_id}")
        assert response.status_code == expected
        if expected == 422:
            assert response.json()["detail"]["code"] == "source_metadata_unavailable"


@pytest.mark.parametrize("failure", ["content", "job", "blueprint"])
def test_dependency_failure_is_503_without_private_diagnostics(source, monkeypatch, failure):
    def unavailable(*args):
        raise TimeoutError("PRIVATE connection credentials")
    repo = SimpleNamespace(get_public_youtube_content=lambda _: source, find_job=lambda *_: None, get_blueprint=lambda *_: None)
    setattr(repo, {"content": "get_public_youtube_content", "job": "find_job", "blueprint": "get_blueprint"}[failure], unavailable)
    monkeypatch.setattr(service, "get_supabase_repository", lambda: repo)
    monkeypatch.setattr(service, "get_settings", lambda: SimpleNamespace(queue_is_configured=True, analysis_version="v1"))
    with TestClient(app) as client:
        result = client.get(f"/api/content/{source.content_id}")
        assert result.status_code == 503 and "PRIVATE" not in result.text
        assert result.json()["detail"]["code"] == "content_context_unavailable"


def test_durable_visibility_and_state_override_hot_cache(source, monkeypatch):
    repo = SimpleNamespace(get_public_youtube_content=lambda _: None)
    monkeypatch.setattr(service, "get_supabase_repository", lambda: repo)
    monkeypatch.setattr(service, "get_settings", lambda: SimpleNamespace(queue_is_configured=True, analysis_version="v1"))
    monkeypatch.setattr(service.processing_queue, "get_content", lambda _: pytest.fail("Do not fall back past visibility"))
    with TestClient(app) as client:
        assert client.get(f"/api/content/{source.content_id}").status_code == 404
    repo.get_public_youtube_content = lambda _: source
    repo.find_job = lambda *_: ProcessingJob(id="job", content_id=source.content_id, analysis_version="v1", status="failed", attempt_count=4)
    repo.get_blueprint = lambda *_: None
    monkeypatch.setattr(service.processing_queue, "find_job", lambda *_: pytest.fail("Do not prefer a stale cache"))
    assert service.read_content_context(source.content_id).processing.job.attempt_count == 4


def test_repository_public_projection_never_requests_private_caption_rpc():
    calls = []
    def respond(request):
        calls.append(request)
        assert request.url.path.endswith("/contents")
        assert request.url.params["visibility"] == "eq.public"
        assert request.url.params["kind"] == "eq.youtube"
        assert request.url.params["select"] == "id,kind,normalized_key,source_url,title,language"
        return httpx.Response(200, json=[])
    repo = SupabaseRepository("https://fixture.invalid", "fake-secret")
    repo._client.close()
    repo._client = httpx.Client(base_url=repo._rest_url, transport=httpx.MockTransport(respond))
    try:
        assert repo.get_public_youtube_content("public-content") is None
        assert len(calls) == 1 and "payload" not in json.dumps(str(calls[0].url))
    finally:
        repo._client.close()


def test_inline_context_uses_inline_processing_even_with_durable_metadata(source, monkeypatch):
    repo = SimpleNamespace(get_public_youtube_content=lambda _: source,
        find_job=lambda *_: pytest.fail("Inline jobs are not stored in the queue repository"))
    monkeypatch.setattr(service, "get_supabase_repository", lambda: repo)
    store.jobs["inline"] = ProcessingJob(id="inline", content_id=source.content_id,
        analysis_version=service.get_settings().analysis_version, status="failed", attempt_count=1)
    assert service.read_content_context(source.content_id).processing.job.id == "inline"

def test_identity_endpoint_reads_only_public_metadata(source, monkeypatch):
    calls = []
    def read(content_id):
        calls.append(content_id)
        return source
    def forbidden(*args):
        pytest.fail("Identity must not read blueprint/job or create processing work")
    repo = SimpleNamespace(get_public_youtube_content=read, find_job=forbidden, get_blueprint=forbidden)
    monkeypatch.setattr(service, "get_supabase_repository", lambda: repo)
    monkeypatch.setattr(service, "get_settings", lambda: SimpleNamespace(queue_is_configured=True))
    monkeypatch.setattr(service.processing_queue, "enqueue", forbidden)
    with TestClient(app) as client:
        result = client.get(f"/api/content/{source.content_id}/identity")
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
    assert result.json() == {"content_id": source.content_id, "kind": "youtube",
        "source_url": "https://www.youtube.com/watch?v=abcdefghijk", "title": None, "language": None}
    assert calls == [source.content_id]


@pytest.mark.parametrize("case,status", [("private", 404), ("missing", 404), ("article", 404), ("conflict", 422), ("outage", 503)])
def test_identity_visibility_conflicts_and_failure_do_not_fall_back(source, monkeypatch, case, status):
    def read(_):
        if case == "outage":
            raise TimeoutError("PRIVATE connection details")
        if case in {"private", "missing"}:
            return None
        return source.model_copy(update={"kind": "article"} if case == "article" else {"source_url": "https://youtu.be/other-video"})
    monkeypatch.setattr(service, "get_supabase_repository", lambda: SimpleNamespace(get_public_youtube_content=read))
    with TestClient(app) as client:
        response = client.get(f"/api/content/{source.content_id}/identity")
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text
