from collections.abc import Iterator
from time import monotonic, sleep
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import StreamingResponse

from app.schemas.job import JobCreateRequest, ProcessingJob
from app.services.job_service import create_or_resume_job, get_job

router = APIRouter()


@router.post("")
def create_job(payload: JobCreateRequest) -> ProcessingJob:
    return create_or_resume_job(payload)


@router.get("/{job_id}")
def read_job(job_id: Annotated[str, Path(min_length=1)]) -> ProcessingJob:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Processing job not found")
    return job


@router.get("/{job_id}/events", response_class=StreamingResponse)
def stream_job(job_id: Annotated[str, Path(min_length=1)]) -> StreamingResponse:
    if get_job(job_id) is None:
        raise HTTPException(status_code=404, detail="Processing job not found")

    def events() -> Iterator[str]:
        last_payload: str | None = None
        last_event_at = monotonic()
        while True:
            job = get_job(job_id)
            if job is None:
                yield 'event: error\ndata: {"detail":"Processing job not found"}\n\n'
                return

            payload = job.model_dump_json()
            if payload != last_payload:
                yield f"event: job\ndata: {payload}\n\n"
                last_payload = payload
                last_event_at = monotonic()
            elif monotonic() - last_event_at >= 15:
                yield ": keep-alive\n\n"
                last_event_at = monotonic()

            if job.status.value in {"ready", "failed"}:
                return
            sleep(0.5)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
