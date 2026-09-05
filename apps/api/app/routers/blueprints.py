from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query

from app.schemas.analysis import LearnerLevel
from app.schemas.blueprint import Blueprint
from app.services.blueprint_service import get_blueprint, personalize_blueprint

router = APIRouter()


@router.get("/{content_id}")
def read_blueprint(
    content_id: Annotated[str, Path(min_length=1)],
    learner_level: Annotated[LearnerLevel | None, Query()] = None,
    corpus_limit: Annotated[int, Query(ge=4, le=24)] = 12,
) -> Blueprint:
    blueprint = get_blueprint(content_id)
    if blueprint is None:
        raise HTTPException(status_code=404, detail="Blueprint not found")
    return personalize_blueprint(blueprint, learner_level, corpus_limit)
