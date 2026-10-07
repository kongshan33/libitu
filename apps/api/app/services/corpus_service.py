import json
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx
from fastapi import HTTPException

from app.config import get_settings
from app.integrations.supabase_repository import get_supabase_repository

from app.schemas.corpus import (
    CorpusItem,
    CorpusItemAnalysisDetail,
    CorpusItemCreate,
    CorpusItemUpdate,
    CorpusSelectionAnalysisRequest,
)
from app.services import store
from app.services.corpus_selection_service import analyze_corpus_selection


def _repository():
    repository = get_supabase_repository()
    if repository is None and get_settings().processing_mode != "inline":
        raise HTTPException(status_code=503, detail="Corpus database is not configured.")
    return repository


def _call(operation, *args):
    try:
        return operation(*args)
    except PermissionError as error:
        raise HTTPException(status_code=404, detail="Source or corpus item not found.") from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Corpus could not be saved or loaded. Please retry.") from error


def list_corpus_items(user_id: str) -> list[CorpusItem]:
    if repository := _repository():
        return _call(repository.list_corpus_items, user_id)
    return [item for item in store.corpus_items.values() if item.user_id == user_id]


def create_corpus_item(user_id: str, payload: CorpusItemCreate) -> CorpusItem:
    client_key = payload.source_locator.client_key
    item_id = str(uuid5(NAMESPACE_URL, json.dumps(["corpus", user_id, client_key]))) if client_key else str(uuid4())
    if repository := _repository():
        return _call(repository.create_corpus_item, user_id, item_id, payload)
    if item_id in store.corpus_items:
        current = store.corpus_items[item_id]
        if current.analysis_detail is None and payload.analysis_detail is not None:
            return update_corpus_item(
                user_id,
                item_id,
                CorpusItemUpdate(analysis_detail=payload.analysis_detail),
            ) or current
        return current
    item = CorpusItem(id=item_id, user_id=user_id, created_at=datetime.now(UTC), updated_at=datetime.now(UTC), **payload.model_dump())
    store.corpus_items[item.id] = item
    return item


def get_corpus_item(user_id: str, item_id: str) -> CorpusItem | None:
    if repository := _repository():
        return _call(repository.get_corpus_item, user_id, item_id)
    item = store.corpus_items.get(item_id)
    return item if item is not None and item.user_id == user_id else None


def hydrate_corpus_analysis_detail(
    user_id: str,
    item_id: str,
    payload: CorpusSelectionAnalysisRequest,
) -> CorpusItem | None:
    current = get_corpus_item(user_id, item_id)
    if current is None:
        return None
    if current.analysis_detail is not None:
        return current

    context = payload.model_copy(update={"content_id": current.content_id})
    detail = CorpusItemAnalysisDetail(
        context=context,
        analysis=analyze_corpus_selection(context),
    )
    return update_corpus_item(
        user_id,
        item_id,
        CorpusItemUpdate(analysis_detail=detail),
    )


def update_corpus_item(user_id: str, item_id: str, payload: CorpusItemUpdate) -> CorpusItem | None:
    if repository := _repository():
        return _call(repository.update_corpus_item, user_id, item_id, payload)
    current = store.corpus_items.get(item_id)
    if current is None or current.user_id != user_id:
        return None
    data = current.model_dump(mode="json", by_alias=True)
    data.update(payload.model_dump(mode="json", by_alias=True, exclude_unset=True))
    data["updated_at"] = datetime.now(UTC)
    updated = CorpusItem(**data)
    store.corpus_items[item_id] = updated
    return updated


def delete_corpus_item(user_id: str, item_id: str) -> bool:
    if repository := _repository():
        return _call(repository.delete_corpus_item, user_id, item_id)
    current = store.corpus_items.get(item_id)
    if current is None or current.user_id != user_id:
        return False
    del store.corpus_items[item_id]
    return True
