from hashlib import sha256
from urllib.parse import parse_qs, urlparse
from uuid import NAMESPACE_URL, uuid5

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.content import ContentKind, ContentResolveRequest, ContentResolveResponse
from app.services import store
from app.services.caption_source import transcript_signature
from app.services.transcript_formatter import caption_track_matches_text, caption_track_to_text


def resolve_content(payload: ContentResolveRequest) -> ContentResolveResponse:
    normalized_key = _normalized_key(payload)
    content_id = str(uuid5(NAMESPACE_URL, normalized_key))
    settings = get_settings()
    repository = get_supabase_repository()
    queued = processing_queue.get_content(content_id) if settings.queue_is_configured else None
    # A cold resolve must not erase an earlier rich source when an older extension
    # sends only plain text. The source RPC is private and is read at most once.
    if queued is None and repository is not None and content_id not in store.content_transcripts:
        queued = repository.get_content(content_id)
    previous_transcript = store.content_transcripts.get(content_id) or (queued.transcript_text if queued else None)
    previous_track = store.content_caption_tracks.get(content_id) or (queued.caption_track if queued else None)
    track = payload.caption_track
    transcript = (caption_track_to_text(track) if track is not None else payload.transcript_text or "").strip()
    if not transcript:
        transcript = (payload.transcript_text or previous_transcript or "").strip()
        track = None
    if track is None and previous_track is not None and caption_track_matches_text(previous_track, transcript, payload.language):
        track = previous_track
    text_changed = bool(transcript and (
        previous_transcript is None or transcript_signature(transcript) != transcript_signature(previous_transcript)
    ))
    content = ContentResolveResponse(
        content_id=content_id,
        kind=payload.kind,
        normalized_key=normalized_key,
        source_url=str(payload.source_url) if payload.source_url else None,
        has_transcript=bool(transcript),
        language=payload.language or (track.language if track else None),
        title=payload.title or (queued.content.title if queued else None),
    )
    if transcript:
        store.content_transcripts[content_id] = transcript
    if track is not None:
        store.content_caption_tracks[content_id] = track
    elif text_changed:
        store.content_caption_tracks.pop(content_id, None)
    if text_changed:
        store.blueprints.pop(content_id, None)
        stale_job_ids = [job_id for job_id, job in store.jobs.items() if job.content_id == content_id]
        for job_id in stale_job_ids:
            store.jobs.pop(job_id, None)

    store.contents[content_id] = content
    if settings.queue_is_configured:
        if text_changed:
            processing_queue.invalidate_content(content_id)
        processing_queue.save_content(content, transcript or None, track)
    if repository is not None:
        repository.save_content(content, transcript or None, track)
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
