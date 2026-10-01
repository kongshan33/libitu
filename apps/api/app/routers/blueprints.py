from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query

from app.schemas.analysis import LearnerLevel
from app.schemas.blueprint import Blueprint
from app.schemas.sound import SentenceSound
from app.integrations.cmudict_lexicon import LexiconUnavailable
from app.services.blueprint_service import get_blueprint, personalize_blueprint
from app.services.sound_service import SoundInputTooLong, get_sentence_sound

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


@router.get("/{content_id}/sentences/{sentence_id}/sound")
def read_sentence_sound(
    content_id: Annotated[str, Path(min_length=1, max_length=250)],
    sentence_id: Annotated[str, Path(min_length=1, max_length=250)],
) -> SentenceSound:
    try:
        result = get_sentence_sound(content_id, sentence_id)
    except LexiconUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except SoundInputTooLong as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Blueprint sentence not found")
    return result
