import json
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx
from fastapi import HTTPException

from app.config import get_settings
from app.integrations.supabase_repository import get_supabase_repository

from app.schemas.corpus import CorpusItem, CorpusItemCreate, CorpusItemUpdate
from app.services import store


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
        return store.corpus_items[item_id]
    item = CorpusItem(id=item_id, user_id=user_id, **payload.model_dump())
    store.corpus_items[item.id] = item
    return item


def update_corpus_item(user_id: str, item_id: str, payload: CorpusItemUpdate) -> CorpusItem | None:
    if repository := _repository():
        return _call(repository.update_corpus_item, user_id, item_id, payload)
    current = store.corpus_items.get(item_id)
    if current is None or current.user_id != user_id:
        return None
    data = current.model_dump()
    data.update(payload.model_dump(exclude_unset=True))
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
