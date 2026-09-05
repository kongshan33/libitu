from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, status

from app.auth import CurrentUserDep
from app.schemas.speaking import SpeakingSession, SpeakingSessionCreate, SpeakingTurnCreate, SpeakingTurnResponse
from app.services.speaking_service import create_speaking_session, submit_turn

router = APIRouter()


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(payload: SpeakingSessionCreate, current_user: CurrentUserDep) -> SpeakingSession:
    return create_speaking_session(current_user.id, payload)


@router.post("/sessions/{session_id}/turns")
async def create_turn(
    session_id: Annotated[str, Path(min_length=1)],
    payload: SpeakingTurnCreate,
    current_user: CurrentUserDep,
) -> SpeakingTurnResponse:
    response = submit_turn(current_user.id, session_id, payload)
    if response is None:
        raise HTTPException(status_code=404, detail="Speaking session not found")
    return response
