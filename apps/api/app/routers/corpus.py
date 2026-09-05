from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Response, status

from app.auth import CurrentUserDep
from app.schemas.corpus import CorpusItem, CorpusItemCreate, CorpusItemUpdate, CorpusSelectionAnalysis, CorpusSelectionAnalysisRequest
from app.services.corpus_selection_service import analyze_corpus_selection
from app.services.corpus_service import create_corpus_item, delete_corpus_item, list_corpus_items, update_corpus_item

router = APIRouter()


@router.post("/analyze-selection")
def analyze_selection(payload: CorpusSelectionAnalysisRequest) -> CorpusSelectionAnalysis:
    return analyze_corpus_selection(payload)


@router.get("")
def list_items(current_user: CurrentUserDep) -> list[CorpusItem]:
    return list_corpus_items(current_user.id)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_item(payload: CorpusItemCreate, current_user: CurrentUserDep) -> CorpusItem:
    return create_corpus_item(current_user.id, payload)


@router.patch("/{item_id}")
def update_item(
    item_id: Annotated[str, Path(min_length=1)],
    payload: CorpusItemUpdate,
    current_user: CurrentUserDep,
) -> CorpusItem:
    item = update_corpus_item(current_user.id, item_id, payload)
    if item is None:
        raise HTTPException(status_code=404, detail="Corpus item not found")
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(item_id: Annotated[str, Path(min_length=1)], current_user: CurrentUserDep) -> Response:
    deleted = delete_corpus_item(current_user.id, item_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Corpus item not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
