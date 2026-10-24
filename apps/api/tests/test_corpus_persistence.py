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


def test_repository_batch_reads_only_selected_owner_items_once_in_requested_order() -> None:
    calls = []

    def row(item_id, owner="user-a"):
        return {"id": item_id, "user_id": owner, **payload().model_dump(mode="json")}

    def respond(request):
        calls.append(request)
        assert request.method == "GET"
        assert request.url.path.endswith("/corpus_items")
        assert request.url.params["user_id"] == "eq.user-a"
        assert request.url.params["id"] == 'in.("second","missing","first","foreign")'
        assert request.url.params["limit"] == "4"
        assert "offset" not in request.url.params
        # Database order is not selection order. Never return an unexpected row
        # or another owner's row even if the adapter receives one.
        return httpx.Response(200, json=[
            row("first"), row("foreign", "user-b"), row("unselected"), row("second"),
        ])

    repo = repository(respond)
    try:
        items = repo.get_corpus_items("user-a", ["second", "missing", "first", "foreign", "second"])
        assert [item.id for item in items] == ["second", "first"]
        assert len(calls) == 1
        assert repo.get_corpus_items("user-a", []) == []
        assert len(calls) == 1
    finally:
        repo._client.close()


def test_service_batch_keeps_owner_order_and_current_sources(monkeypatch) -> None:
    monkeypatch.setattr(corpus_service, "get_supabase_repository", lambda: None)
    first = corpus_service.create_corpus_item("batch-owner", payload())
    second = corpus_service.create_corpus_item("batch-owner", payload().model_copy(update={
        "source_locator": payload().source_locator.model_copy(update={"client_key": "second"}),
    }))
    foreign = corpus_service.create_corpus_item("batch-other", payload())
    corpus_service.update_corpus_item("batch-owner", first.id, CorpusItemUpdate(text="changed wording"))
    selected = [second.id, "missing", first.id, foreign.id, second.id]
    items = corpus_service.get_corpus_items("batch-owner", selected)
    assert [item.id for item in items] == [second.id, first.id]
    assert items[1].text == "changed wording"
    corpus_service.delete_corpus_item("batch-owner", second.id)
    assert [item.id for item in corpus_service.get_corpus_items("batch-owner", selected)] == [first.id]


def test_service_batch_calls_repository_once_and_preserves_failure(monkeypatch) -> None:
    calls = []

    def unavailable(user_id, item_ids):
        calls.append((user_id, item_ids))
        raise httpx.ConnectError("database unavailable")

    monkeypatch.setattr(corpus_service, "get_supabase_repository", lambda: SimpleNamespace(get_corpus_items=unavailable))
    assert corpus_service.get_corpus_items("user-a", []) == []
    with pytest.raises(HTTPException) as error:
        corpus_service.get_corpus_items("user-a", ["second", "first", "second"])
    assert error.value.status_code == 503
    assert calls == [("user-a", ["second", "first"])]


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


def test_edit_preserves_source_identity_and_dates(monkeypatch) -> None:
    monkeypatch.setattr(corpus_service, "get_supabase_repository", lambda: None)
    original = corpus_service.create_corpus_item("library-owner", payload())
    edited = corpus_service.update_corpus_item("library-owner", original.id, CorpusItemUpdate(
        text="commit further", meaning="My explanation", tags=["softening"], usage_context="My note",
    ))
    assert edited.id == original.id
    assert edited.created_at == original.created_at
    assert edited.updated_at >= original.updated_at
    assert edited.source_locator == original.source_locator
    assert corpus_service.create_corpus_item("library-owner", payload()).text == "commit further"
    assert corpus_service.list_corpus_items("library-owner")[0].meaning == "My explanation"
    assert corpus_service.update_corpus_item("library-other", original.id, CorpusItemUpdate(text="stolen")) is None


@pytest.mark.parametrize("patch", [{"text": None}, {"text": "   "}, {"text": "a" * 2001}, {"tags": None}, {"slots": None}])
def test_edit_rejects_invalid_fields(patch) -> None:
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        CorpusItemUpdate.model_validate(patch)
