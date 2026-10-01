from collections.abc import Iterator
import json
from time import monotonic, sleep
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query
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
def stream_job(
    job_id: Annotated[str, Path(min_length=1)],
    compact_word_timings: Annotated[bool, Query()] = False,
) -> StreamingResponse:
    if get_job(job_id) is None:
        raise HTTPException(status_code=404, detail="Processing job not found")

    def events() -> Iterator[str]:
        last_payload: str | None = None
        last_event_at = monotonic()
        sent_words: dict[str, tuple[tuple, list[dict]]] = {}
        while True:
            job = get_job(job_id)
            if job is None:
                yield 'event: error\ndata: {"detail":"Processing job not found"}\n\n'
                return

            payload = job.model_dump_json()
            if payload != last_payload:
                event_payload = payload
                if compact_word_timings:
                    # Opt-in only: older clients continue receiving complete job
                    # snapshots. A fresh/reconnected stream always sends full words.
                    document = job.model_dump(mode="json")
                    _compact_word_timings(document, sent_words)
                    event_payload = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
                yield f"event: job\ndata: {event_payload}\n\n"
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


def _compact_word_timings(document: dict, sent: dict[str, tuple[tuple, list[dict]]]) -> None:
    """Omission means unchanged for this exact immutable source row, never unknown."""
    preview = document.get("analysis_preview") or {}
    current: dict[str, tuple[tuple, list[dict]]] = {}
    for row in preview.get("transcript_lines") or []:
        row_id = row.get("id")
        words = row.get("word_timings")
        if not row_id or not words:
            continue
        identity = (
            row.get("segmentation_version"), row.get("source_token_start"), row.get("source_token_end"),
            row.get("text"), row.get("timing_source"), row.get("start_ms"), row.get("end_ms"),
        )
        value = (identity, words)
        if sent.get(row_id) == value:
            row.pop("word_timings")
        current[row_id] = value
    # Retain only the bounded current preview, not every past source/retry version.
    sent.clear()
    sent.update(current)
