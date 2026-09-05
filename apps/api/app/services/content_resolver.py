from hashlib import sha256
from urllib.parse import parse_qs, urlparse
from uuid import NAMESPACE_URL, uuid5

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.content import ContentKind, ContentResolveRequest, ContentResolveResponse
from app.services import store


def resolve_content(payload: ContentResolveRequest) -> ContentResolveResponse:
    normalized_key = _normalized_key(payload)
    content_id = str(uuid5(NAMESPACE_URL, normalized_key))
    transcript = (payload.transcript_text or "").strip()
    content = ContentResolveResponse(
        content_id=content_id,
        kind=payload.kind,
        normalized_key=normalized_key,
        source_url=str(payload.source_url) if payload.source_url else None,
        has_transcript=bool(transcript or store.content_transcripts.get(content_id)),
        language=payload.language,
        title=payload.title,
    )
    previous_transcript = store.content_transcripts.get(content_id)
    if transcript and transcript != previous_transcript:
        store.content_transcripts[content_id] = transcript
        store.blueprints.pop(content_id, None)
        stale_job_ids = [job_id for job_id, job in store.jobs.items() if job.content_id == content_id]
        for job_id in stale_job_ids:
            store.jobs.pop(job_id, None)

    store.contents[content_id] = content
    if get_settings().queue_is_configured:
        queued = processing_queue.get_content(content_id)
        previous_queued_transcript = queued.transcript_text if queued else None
        if transcript and transcript != previous_queued_transcript:
            processing_queue.invalidate_content(content_id)
        processing_queue.save_content(content, transcript or previous_queued_transcript)
    repository = get_supabase_repository()
    if repository is not None:
        repository.save_content(content, transcript or store.content_transcripts.get(content_id))
    return content


def _normalized_key(payload: ContentResolveRequest) -> str:
    if payload.kind == ContentKind.pasted_text:
        text = " ".join((payload.pasted_text or "").split())
        return f"pasted:{sha256(text.encode('utf-8')).hexdigest()}"

    source_url = str(payload.source_url) if payload.source_url else ""
    if payload.kind == ContentKind.youtube:
        video_id = _youtube_video_id(source_url)
        return f"youtube:{video_id or source_url}"

    parsed = urlparse(source_url)
    path = parsed.path.rstrip("/") or "/"
    return f"article:{parsed.netloc.lower()}{path}"


def _youtube_video_id(source_url: str) -> str | None:
    parsed = urlparse(source_url)
    if parsed.netloc.endswith("youtu.be"):
        return parsed.path.strip("/") or None
    query_video_id = parse_qs(parsed.query).get("v")
    if query_video_id:
        return query_video_id[0]
    return None
