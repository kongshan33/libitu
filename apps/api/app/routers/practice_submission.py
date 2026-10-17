from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from app.auth import CurrentUserDep
from app.integrations.practice_repository import PracticeRepository, get_practice_repository
from app.routers.practice_analysis import Repo
from app.schemas.practice import MAX_RECORDING_BYTES, PracticeAttempt
from app.schemas.practice_submission import PracticeSubmission
from app.services import practice_submission_service

router = APIRouter(prefix='/api/practice/attempts', tags=['practice-analysis'])
MAX_METADATA_BYTES = 64 * 1024
MAX_BODY_BYTES = MAX_RECORDING_BYTES + MAX_METADATA_BYTES + 4096


@router.post('/submit', status_code=202)
async def submit(request: Request, user: CurrentUserDep, repo: Repo,
                 recordings: Annotated[PracticeRepository | None, Depends(get_practice_repository)]) -> PracticeAttempt:
    if request.headers.get('content-type', '').split(';', 1)[0].lower() != 'multipart/form-data':
        raise HTTPException(415, 'Submit metadata and audio as multipart/form-data')
    async def bounded_stream():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_BODY_BYTES:
                # Parser closes temporary files when this exception is raised.
                raise MultiPartException('Submission too large')
            yield chunk
    parser = MultiPartParser(request.headers, bounded_stream(), max_files=1, max_fields=1,
                             max_part_size=MAX_METADATA_BYTES)
    try:
        form = await parser.parse()
    except MultiPartException as error:
        raise HTTPException(413 if error.message == 'Submission too large' else 422, error.message) from error
    try:
        if set(form.keys()) != {'metadata', 'audio'}:
            raise HTTPException(422, 'Exactly metadata and audio are required')
        metadata, audio = form['metadata'], form['audio']
        if not isinstance(metadata, str) or not isinstance(audio, UploadFile):
            raise HTTPException(422, 'Invalid submission parts')
        try:
            payload = PracticeSubmission.model_validate_json(metadata)
        except ValidationError as error:
            raise HTTPException(422, 'Invalid submission metadata') from error
        if audio.size is not None and audio.size > MAX_RECORDING_BYTES:
            raise HTTPException(413, 'Recording must be no larger than 8 MiB')
        data = await audio.read(MAX_RECORDING_BYTES + 1)
        if len(data) > MAX_RECORDING_BYTES:
            raise HTTPException(413, 'Recording must be no larger than 8 MiB')
        mime = (audio.content_type or '').split(';', 1)[0].lower()
        return await run_in_threadpool(practice_submission_service.submit, repo, recordings, user.id, payload, data, mime)
    finally:
        await form.close()
