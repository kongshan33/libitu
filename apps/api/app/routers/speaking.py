from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, status
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from app.auth import CurrentUserDep
from app.schemas.speaking import (
    SpeakingOptions, SpeakingSession, SpeakingSessionCreate, SpeakingTurnCreate, SpeakingTurnResponse,
)
from app.services.speaking_service import (
    create_speaking_session, get_speaking_session, speaking_options, submit_turn,
)
from app.schemas.speaking_runtime import RealtimeStart, RealtimeTicket, SpeakingWorkspace
from app.services import speaking_runtime_state
from app.services.speaking_runtime import accept_connection
from app.services.speaking_lifecycle import end_speaking_session, delete_speaking_session
from app.schemas.speaking_feedback import FeedbackRequest, SpeakingFeedback
from app.services.speaking_feedback_service import read_feedback, request_feedback

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


@router.get("/sessions/{session_id}/workspace")
def get_workspace(session_id: UUID, current_user: CurrentUserDep) -> SpeakingWorkspace:
    return speaking_runtime_state.public_workspace(current_user.id, str(session_id))


@router.post("/sessions/{session_id}/realtime")
def start_realtime(session_id: UUID, payload: RealtimeStart, current_user: CurrentUserDep) -> RealtimeTicket:
    return speaking_runtime_state.create_ticket(current_user.id, str(session_id), payload)


@router.websocket("/sessions/{session_id}/realtime/{runtime_id}")
async def realtime_connection(websocket: WebSocket, session_id: UUID, runtime_id: UUID) -> None:
    await accept_connection(websocket, str(session_id), str(runtime_id))


@router.post("/sessions/{session_id}/end")
async def end_mission(session_id: UUID, current_user: CurrentUserDep) -> SpeakingWorkspace:
    return await end_speaking_session(current_user.id, str(session_id))


@router.post("/sessions/{session_id}/feedback")
def create_feedback(session_id: UUID, payload: FeedbackRequest, current_user: CurrentUserDep) -> SpeakingFeedback:
    return request_feedback(current_user.id, str(session_id), retry=payload.retry)


@router.get("/sessions/{session_id}/feedback")
def get_feedback(session_id: UUID, current_user: CurrentUserDep) -> SpeakingFeedback:
    return read_feedback(current_user.id, str(session_id))


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_mission(session_id: UUID, current_user: CurrentUserDep) -> Response:
    await delete_speaking_session(current_user.id, str(session_id))
    return Response(status_code=204)
