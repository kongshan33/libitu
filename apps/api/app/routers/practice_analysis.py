from collections.abc import Iterator
from typing import Annotated, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool
from app.auth import CurrentUserDep
from app.integrations.practice_analysis_repository import PracticeAnalysisRepository, get_practice_analysis_repository
from app.schemas.practice_analysis import AnalysisCreate, AnalysisView
from app.schemas.practice import RecognitionFeedback, RecognitionFeedbackCreate
from app.services import practice_analysis_service as service
from app.integrations.practice_repository import PracticeRepository, get_practice_repository

router = APIRouter(prefix="/api/practice/attempts", tags=["practice-analysis"])


def repository() -> Iterator[PracticeAnalysisRepository]:
    repo = get_practice_analysis_repository()
    if repo is None:
        raise HTTPException(503, "Server analysis storage is unavailable. Keep this page open and retry.")
    try:
        yield repo
    except httpx.HTTPError as error:
        raise HTTPException(503, "Server analysis is temporarily unavailable. Retry shortly.") from error


Repo = Annotated[PracticeAnalysisRepository, Depends(repository)]


@router.post("/{attempt_id}/analysis", status_code=202)
def create(attempt_id: UUID, payload: AnalysisCreate, user: CurrentUserDep, repo: Repo) -> AnalysisView:
    return service.create(repo, user.id, str(attempt_id), payload)


@router.get("/{attempt_id}/analysis", response_model=AnalysisView | None)
def status(attempt_id: UUID, user: CurrentUserDep, repo: Repo) -> AnalysisView | None:
    return service.read(repo, user.id, str(attempt_id))


@router.put("/{attempt_id}/recognition-feedback")
def recognition_feedback(attempt_id: UUID, payload: RecognitionFeedbackCreate,
                         user: CurrentUserDep, repo: Repo) -> RecognitionFeedback:
    return service.mark_recognition_error(repo, user.id, str(attempt_id))


@router.put("/{attempt_id}/analysis/audio")
async def upload(attempt_id: UUID, request: Request, user: CurrentUserDep, repo: Repo,
                 recordings: Annotated[PracticeRepository | None, Depends(get_practice_repository)],
                 retain_recording: Annotated[bool, Query()] = False) -> AnalysisView:
    await run_in_threadpool(service.owned, repo, user.id, str(attempt_id))
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > 8 * 1024 * 1024:
            raise HTTPException(413, "Recording must be no larger than 8 MiB")
        data.extend(chunk)
    mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if retain_recording:
        return await run_in_threadpool(service.upload_with_recording, repo, recordings, user.id, str(attempt_id), bytes(data), mime)
    return await run_in_threadpool(service.upload, repo, user.id, str(attempt_id), bytes(data), mime)


@router.post("/{attempt_id}/analysis/{action}")
def control(attempt_id: UUID, action: Literal["retry", "cancel"], user: CurrentUserDep, repo: Repo) -> AnalysisView:
    return service.control(repo, user.id, str(attempt_id), action)


@router.delete("/{attempt_id}/analysis", status_code=204)
def delete(attempt_id: UUID, user: CurrentUserDep, repo: Repo) -> Response:
    service.delete(repo, user.id, str(attempt_id))
    return Response(status_code=204)
