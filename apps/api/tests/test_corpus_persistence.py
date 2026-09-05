import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app.integrations.supabase_repository import SupabaseRepository
from app.schemas.corpus import CorpusItemCreate, CorpusItemUpdate
from app.services import corpus_service


def payload() -> CorpusItemCreate:
    return CorpusItemCreate.model_validate({
        "kind": "idiom", "text": "double down on", "meaning": "Increase commitment.",
        "source_locator": {
            "client_key": "video:idiom:double-down-on",
            "snapshot": {"id": "idiom-1", "kind": "idiom", "text": "double down on",
                         "tags": ["idiom"], "meta": "0:01 - B2", "register": "professional"},
        },
    })


def repository(handler) -> SupabaseRepository:
    repo = SupabaseRepository("https://example.supabase.co", "test-key")
    repo._client.close()
    repo._client = httpx.Client(base_url="https://example.supabase.co/rest/v1", transport=httpx.MockTransport(handler))
    return repo


def test_repository_scopes_every_corpus_read_update_and_delete() -> None:
    calls = []

    def respond(request):
        calls.append(request)
        assert request.url.params["user_id"] == "eq.user-a"
        if request.method != "GET" or "id" in request.url.params:
            assert request.url.params["id"] == "eq.item-a"
        return httpx.Response(200, json=[])

    repo = repository(respond)
    try:
        assert repo.list_corpus_items("user-a") == []
        assert repo.get_corpus_item("user-a", "item-a") is None
        assert repo.update_corpus_item("user-a", "item-a", CorpusItemUpdate(text="changed")) is None
        assert repo.delete_corpus_item("user-a", "item-a") is False
        assert [request.method for request in calls] == ["GET", "GET", "PATCH", "DELETE"]
    finally:
        repo._client.close()


def test_repeated_import_preserves_cloud_edits_and_learning_snapshot() -> None:
    stored = None

    def respond(request):
        nonlocal stored
        if request.url.path.endswith("/profiles"):
            assert json.loads(request.content) == {"id": "user-a"}
            return httpx.Response(201)
        if request.method == "POST":
            assert "resolution=ignore-duplicates" in request.headers["Prefer"]
            body = json.loads(request.content)
            assert body["user_id"] == "user-a"
            assert body["source_locator"]["snapshot"]["register"] == "professional"
            if stored is not None:
                return httpx.Response(201, json=[])
            stored = body
            return httpx.Response(201, json=[stored])
        assert request.url.params["user_id"] == "eq.user-a"
        assert request.url.params["id"] == "eq.item-a"
        return httpx.Response(200, json=[stored])

    repo = repository(respond)
    try:
        first = repo.create_corpus_item("user-a", "item-a", payload())
        assert first.source_locator.snapshot.usage_register == "professional"
        stored["meaning"] = "Edited by learner"
        second = repo.create_corpus_item("user-a", "item-a", payload())
        assert second.meaning == "Edited by learner"
    finally:
        repo._client.close()


def test_cannot_link_another_users_private_content() -> None:
    def respond(request):
        assert request.method == "GET"
        assert request.url.path.endswith("/contents")
        return httpx.Response(200, json=[{"visibility": "private", "owner_user_id": "user-b"}])

    repo = repository(respond)
    try:
        with pytest.raises(PermissionError):
            repo.create_corpus_item("user-a", "item-a", payload().model_copy(update={"content_id": "private-content"}))
    finally:
        repo._client.close()


def test_service_uses_owner_scoped_idempotency_keys(monkeypatch) -> None:
    monkeypatch.setattr(corpus_service, "get_supabase_repository", lambda: None)
    first = corpus_service.create_corpus_item("idempotent-a", payload())
    corpus_service.update_corpus_item("idempotent-a", first.id, CorpusItemUpdate(meaning="Edited"))
    repeated = corpus_service.create_corpus_item("idempotent-a", payload())
    other = corpus_service.create_corpus_item("idempotent-b", payload())
    assert first.id == repeated.id
    assert repeated.meaning == "Edited"
    assert other.id != first.id
    assert corpus_service.delete_corpus_item("idempotent-b", first.id) is False


def test_missing_production_database_does_not_fall_back_to_memory(monkeypatch) -> None:
    monkeypatch.setattr(corpus_service, "get_supabase_repository", lambda: None)
    monkeypatch.setattr(corpus_service, "get_settings", lambda: SimpleNamespace(processing_mode="queue"))
    with pytest.raises(HTTPException) as error:
        corpus_service.create_corpus_item("user-a", payload())
    assert error.value.status_code == 503


def test_database_failure_is_retryable_and_does_not_fall_back_to_memory(monkeypatch) -> None:
    def unavailable(*_args):
        raise httpx.ConnectError("database unavailable")

    monkeypatch.setattr(corpus_service, "get_supabase_repository", lambda: SimpleNamespace(create_corpus_item=unavailable))
    with pytest.raises(HTTPException) as error:
        corpus_service.create_corpus_item("user-a", payload())
    assert error.value.status_code == 503
