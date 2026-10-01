from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from app.auth import CurrentUserDep
from app.schemas.speaking import (
    SpeakingOptions, SpeakingSession, SpeakingSessionCreate, SpeakingTurnCreate, SpeakingTurnResponse,
)
from app.services.speaking_service import (
    create_speaking_session, get_speaking_session, speaking_options, submit_turn,
)


class SpeakingRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def safe_validation(request: Request):
            try:
                return await handler(request)
            except RequestValidationError as error:
                raise HTTPException(
                    status_code=422,
                    detail="Check the scenario, goal, settings and selected corpus items before continuing.",
                ) from error

        return safe_validation


router = APIRouter(route_class=SpeakingRoute)


@router.get("/options")
def get_options() -> SpeakingOptions:
    return speaking_options()


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def create_session(payload: SpeakingSessionCreate, current_user: CurrentUserDep) -> SpeakingSession:
    return create_speaking_session(current_user.id, payload)


@router.get("/sessions/{session_id}")
def get_session(session_id: UUID, current_user: CurrentUserDep) -> SpeakingSession:
    session = get_speaking_session(current_user.id, str(session_id))
    if session is None:
        raise HTTPException(status_code=404, detail="Speaking session not found.")
    return session


@router.post("/sessions/{session_id}/turns")
def create_turn(
    session_id: UUID, payload: SpeakingTurnCreate, current_user: CurrentUserDep,
) -> SpeakingTurnResponse:
    response = submit_turn(current_user.id, str(session_id), payload)
    if response is None:
        raise HTTPException(status_code=404, detail="Speaking session not found.")
    return response
