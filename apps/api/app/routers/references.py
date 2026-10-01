from collections.abc import Iterator
import asyncio
import json
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.responses import StreamingResponse

from app.auth import CurrentUserDep
from app.integrations.reference_repository import ReferenceRepository, get_reference_repository
from app.schemas.reference import MAX_REFERENCE_BYTES, PrepareCapture, PrepareReference, ReferenceCapability, ReferenceView
from app.services import reference_service as service
from app.services.acoustics import sources
from app.services.acoustics.engine import engine_identity
from app.config import get_settings

router = APIRouter(prefix="/api/references", tags=["references"])


def repository() -> Iterator[ReferenceRepository]:
    repo = get_reference_repository()
    if repo is None:
        raise HTTPException(503, "Reference storage is unavailable.")
    try:
        yield repo
    except httpx.HTTPError as error:
        raise HTTPException(503, "Reference storage is unavailable. Please retry.") from error
    except (OSError, ValueError) as error:
        raise HTTPException(503, "Reference configuration is unavailable.") from error


RepositoryDep = Annotated[ReferenceRepository, Depends(repository)]


@router.get('/capability')
def capability(content_id: UUID, segment_id: Annotated[str, Query(min_length=1, max_length=200)],
               user: CurrentUserDep, repo: RepositoryDep) -> ReferenceCapability:
    data = service.snapshot(repo, user.id, str(content_id), segment_id)
    grant = sources.resolve(user.id, str(content_id), data['start_ms'], data['end_ms'])
    return ReferenceCapability(available=grant is not None, input_mode=grant.mode if grant else None,
                               reason=None if grant else 'file_source_unavailable')


@router.post('', status_code=202)
def prepare(payload: PrepareReference, user: CurrentUserDep, repo: RepositoryDep) -> ReferenceView:
    return service.prepare(repo, user.id, payload)


@router.post('/captures', status_code=202)
def prepare_capture(payload: PrepareCapture, user: CurrentUserDep, repo: RepositoryDep) -> ReferenceView:
    return service.prepare_capture(repo, user.id, payload)


@router.get('/captures/latest')
def latest_capture(content_id: UUID, segment_id: Annotated[str, Query(min_length=1, max_length=200)],
                   sentence_id: Annotated[str, Query(min_length=1, max_length=200)],
                   user: CurrentUserDep, repo: RepositoryDep) -> ReferenceView | None:
    return service.latest_capture(repo, user.id, str(content_id), segment_id, sentence_id)


@router.get('/{reference_id}')
def status(reference_id: UUID, user: CurrentUserDep, repo: RepositoryDep) -> ReferenceView:
    return ReferenceView.model_validate(service.owned(repo, user.id, str(reference_id)))


@router.get('/{reference_id}/events')
async def events(reference_id: UUID, request: Request, user: CurrentUserDep, repo: RepositoryDep) -> StreamingResponse:
    await run_in_threadpool(service.owned, repo, user.id, str(reference_id))

    async def updates():
        previous = None
        while not await request.is_disconnected():
            try:
                row = await run_in_threadpool(service.owned, repo, user.id, str(reference_id))
                encoded = ReferenceView.model_validate(row).model_dump_json()
            except (httpx.HTTPError, HTTPException, OSError, ValueError):
                yield 'event: unavailable\ndata: ' + json.dumps({'message': 'Reference status is unavailable.'}) + '\n\n'
                return
            if encoded != previous:
                yield f'event: reference\ndata: {encoded}\n\n'
                previous = encoded
            else:
                yield ': heartbeat\n\n'
            if row['state'] not in ('queued', 'processing'):
                return
            await asyncio.sleep(2)

    return StreamingResponse(updates(), media_type='text/event-stream',
                             headers={'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no'})


@router.put('/{reference_id}/audio')
async def upload(reference_id: UUID, request: Request, user: CurrentUserDep, repo: RepositoryDep) -> ReferenceView:
    row = await run_in_threadpool(service.owned, repo, user.id, str(reference_id))
    if row['input_mode'] != 'upload':
        raise HTTPException(409, 'This reference uses a server file.')
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_REFERENCE_BYTES:
            raise HTTPException(413, 'Reference upload exceeds 32 MiB.')
        data.extend(chunk)
    return await run_in_threadpool(service.upload, repo, user.id, str(reference_id), bytes(data))


@router.get('/{reference_id}/audio')
def audio(reference_id: UUID, user: CurrentUserDep, repo: RepositoryDep,
          sentence_id: Annotated[str | None, Query(min_length=1, max_length=200)] = None) -> Response:
    row = service.owned(repo, user.id, str(reference_id))
    data = service.sentence_audio(repo, row, sentence_id)
    # Recheck after storage IO so a concurrent deletion is not acknowledged as playable.
    service.owned(repo, user.id, str(reference_id))
    return Response(data, media_type='audio/wav', headers={'Cache-Control': 'private, no-store',
                                                         'X-Content-Type-Options': 'nosniff'})


@router.post('/{reference_id}/cancel')
def cancel(reference_id: UUID, user: CurrentUserDep, repo: RepositoryDep) -> ReferenceView:
    service.owned(repo, user.id, str(reference_id))
    return ReferenceView.model_validate(repo.control(user.id, str(reference_id), 'cancel'))


@router.post('/{reference_id}/retry', status_code=202)
def retry(reference_id: UUID, user: CurrentUserDep, repo: RepositoryDep) -> ReferenceView:
    row = service.owned(repo, user.id, str(reference_id))
    if row['snapshot']['engine'] != engine_identity(get_settings()):
        raise HTTPException(409, 'The analysis version changed. Reopen this segment to prepare a new reference.')
    return ReferenceView.model_validate(repo.control(user.id, str(reference_id), 'retry'))


@router.delete('/{reference_id}', status_code=204)
def remove(reference_id: UUID, user: CurrentUserDep, repo: RepositoryDep) -> Response:
    row = service.owned(repo, user.id, str(reference_id), allow_deleted=True)
    repo.control(user.id, str(reference_id), 'delete')
    repo.remove_audio(row)
    return Response(status_code=204)
