from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response, WebSocket, status
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
from app.services.speaking_diagnostics import read_events
from app.schemas.speaking_plan import PracticePlanCreate, SpeakingPlan, SpeakingPlanCreate
from app.services.speaking_planning import create_practice_plan, create_speaking_plan, read_speaking_plan
from app.schemas.speaking_progress import (
    PracticeComparison, SupportRecommendation, SupportRecommendationRequest,
)
from app.services.speaking_progress import compare_practice, recommend_support
from app.services.speaking_timing import measure_phase, request_timing


_PREPARATION_OPERATIONS = {
    "create_plan": "plan", "practice_plan": "practice_plan",
    "create_session": "create", "get_workspace": "workspace",
}

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

        operation = _PREPARATION_OPERATIONS.get(self.name)
        if operation is None:
            return safe_validation

        async def timed_preparation(request: Request):
            with request_timing(operation) as timing:
                try:
                    response = await safe_validation(request)
                except HTTPException as error:
                    error.headers = {**(error.headers or {}), **timing.finish(error.status_code)}
                    raise
                except BaseException:
                    # Cancellation and unexpected errors still retain measured work
                    # in server diagnostics; never include the exception contents.
                    timing.finish(500)
                    raise
                response.headers.update(timing.finish(response.status_code))
                return response

        return timed_preparation


router = APIRouter(route_class=SpeakingRoute)


@router.get("/options")
def get_options() -> SpeakingOptions:
    return speaking_options()


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def create_session(payload: SpeakingSessionCreate, current_user: CurrentUserDep) -> SpeakingSession:
    with measure_phase("create"):
        return create_speaking_session(current_user.id, payload)


@router.post("/plans", status_code=status.HTTP_201_CREATED)
async def create_plan(payload: SpeakingPlanCreate, current_user: CurrentUserDep) -> SpeakingPlan:
    return await create_speaking_plan(current_user.id, payload)


@router.post("/support-recommendations")
def support_recommendations(
    payload: SupportRecommendationRequest, current_user: CurrentUserDep,
) -> SupportRecommendation:
    return recommend_support(current_user.id, payload)


@router.post("/sessions/{session_id}/practice-plans", status_code=status.HTTP_201_CREATED)
async def practice_plan(
    session_id: UUID, payload: PracticePlanCreate, current_user: CurrentUserDep,
) -> SpeakingPlan:
    return await create_practice_plan(current_user.id, str(session_id), payload)


@router.get("/sessions/{session_id}/practice-comparison")
def practice_comparison(session_id: UUID, current_user: CurrentUserDep) -> PracticeComparison:
    return compare_practice(current_user.id, str(session_id))


@router.get("/plans/{plan_id}")
def get_plan(plan_id: UUID, current_user: CurrentUserDep) -> SpeakingPlan:
    plan = read_speaking_plan(current_user.id, str(plan_id))
    if plan is None:
        raise HTTPException(status_code=404, detail="Speaking plan not found.")
    return plan


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


@router.get("/sessions/{session_id}/diagnostics")
def get_diagnostics(
    session_id: UUID, current_user: CurrentUserDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 200,
    before: Annotated[UUID | None, Query()] = None,
) -> dict:
    return read_events(current_user.id, str(session_id), limit, str(before) if before else None)


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
