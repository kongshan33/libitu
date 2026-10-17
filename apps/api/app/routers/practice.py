from collections.abc import Iterator
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from app.auth import CurrentUserDep
from app.integrations.practice_repository import PracticeRepository, get_practice_repository
from app.schemas.practice import AttemptCreate, AttemptPage, MAX_RECORDING_BYTES, PracticeAttempt, PracticeProgress
from app.services.practice_service import create_attempt, delete_recording, directory_progress, owned, upload_recording

router = APIRouter(prefix="/api/practice/attempts", tags=["practice"])


def repository() -> Iterator[PracticeRepository]:
    repo = get_practice_repository()
    if repo is None:
        raise HTTPException(503, "Practice storage is unavailable. Keep this page open and retry.")
    try:
        yield repo
    except httpx.HTTPError as error:
        raise HTTPException(503, "Practice storage is unavailable. Keep this page open and retry.") from error


RepositoryDep = Annotated[PracticeRepository, Depends(repository)]


@router.post("", status_code=201)
def create(payload: AttemptCreate, user: CurrentUserDep, repo: RepositoryDep) -> PracticeAttempt:
    return create_attempt(repo, user.id, payload)


@router.get("")
def history(user: CurrentUserDep, repo: RepositoryDep, content_id: UUID,
            sentence_id: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
            offset: Annotated[int, Query(ge=0, le=100000)] = 0,
            limit: Annotated[int, Query(ge=1, le=100)] = 20) -> AttemptPage:
    rows = repo.list(user.id, str(content_id), sentence_id, offset, limit + 1)
    return AttemptPage(items=[PracticeAttempt.model_validate(row) for row in rows[:limit]],
                       next_offset=offset + limit if len(rows) > limit else None)


@router.get("/progress")
def progress(user: CurrentUserDep, repo: RepositoryDep, content_id: UUID) -> PracticeProgress:
    return directory_progress(repo, user.id, str(content_id))


@router.put("/{attempt_id}/recording")
async def upload(attempt_id: UUID, request: Request, user: CurrentUserDep, repo: RepositoryDep) -> PracticeAttempt:
    # Check ownership before consuming bytes, then enforce the cap on the stream,
    # including chunked requests without Content-Length. Blocking IO stays in a worker.
    await run_in_threadpool(owned, repo, user.id, str(attempt_id))
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_RECORDING_BYTES:
            raise HTTPException(413, "Recording must be no larger than 8 MiB")
        data.extend(chunk)
    mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    return await run_in_threadpool(upload_recording, repo, user.id, str(attempt_id), bytes(data), mime)


@router.get("/{attempt_id}/recording")
def recording(attempt_id: UUID, user: CurrentUserDep, repo: RepositoryDep) -> Response:
    row = owned(repo, user.id, str(attempt_id))
    if row["recording_state"] != "ready":
        raise HTTPException(404, "Recording is not available")
    data = repo.read_audio(row)
    return Response(content=data, media_type=row["recording_mime"],
                    headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.delete("/{attempt_id}/recording", status_code=204)
def remove_recording(attempt_id: UUID, user: CurrentUserDep, repo: RepositoryDep) -> Response:
    delete_recording(repo, user.id, str(attempt_id))
    return Response(status_code=204)


@router.delete("/{attempt_id}", status_code=204)
def remove_attempt(attempt_id: UUID, user: CurrentUserDep, repo: RepositoryDep) -> Response:
    delete_recording(repo, user.id, str(attempt_id), entire_attempt=True)
    return Response(status_code=204)
