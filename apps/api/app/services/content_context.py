"""Read-only public metadata and processing observation, never an ensure command."""
import re
from urllib.parse import parse_qs, urlparse

from fastapi import HTTPException

from app.config import Settings, get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import SupabaseRepository, get_supabase_repository
from app.schemas.content import ContentContext, ContentProcessing, ContentJobSummary, PublicContent
from app.services import store


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message}, headers={"Cache-Control": "no-store"})


def canonical_source(source: str | None, normalized_key: str) -> str:
    video_id = normalized_key.removeprefix("youtube:") if normalized_key.startswith("youtube:") else ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise _error(422, "source_metadata_unavailable", "Open the original YouTube video again.")
    if source:
        try:
            url = urlparse(source)
            host = (url.hostname or "").lower()
            query = parse_qs(url.query)
            source_id = url.path.strip("/") if host == "youtu.be" else (
                url.path.split("/")[2] if url.path.startswith("/shorts/") else query.get("v", [None])[0]
            ) if host in {"youtube.com", "www.youtube.com", "m.youtube.com"} else None
            valid_path = (host == "youtu.be" and url.path.strip("/") == video_id) or (
                host in {"youtube.com", "www.youtube.com", "m.youtube.com"}
                and (url.path == "/watch" or url.path.rstrip("/") == f"/shorts/{video_id}")
            )
            if not valid_path or len(query.get("v", [])) > 1 or url.scheme not in {"http", "https"} or url.username or url.password or url.port or source_id != video_id:
                raise ValueError("Source conflict")
        except (ValueError, IndexError):
            raise _error(422, "source_metadata_unavailable", "Open the original YouTube video again.") from None
    return f"https://www.youtube.com/watch?v={video_id}"


def _public_content(content_id: str, repository: SupabaseRepository | None, settings: Settings) -> PublicContent:
    if repository is not None:
        # Do not fall back to a public cache after a private/deleted durable row.
        content = repository.get_public_youtube_content(content_id)
    elif settings.queue_is_configured:
        queued = processing_queue.get_content(content_id)
        content = queued.content if queued else None
    else:
        content = store.contents.get(content_id)
    if content is None or content.kind != "youtube":
        raise _error(404, "content_not_found", "Content not found.")
    source = canonical_source(content.source_url, content.normalized_key)
    return PublicContent(content_id=content_id, source_url=source, title=content.title, language=content.language)


def read_public_content(content_id: str) -> PublicContent:
    """Identity-only read: no blueprint/job reads or processing side effects."""
    try:
        return _public_content(content_id, get_supabase_repository(), get_settings())
    except HTTPException:
        raise
    except Exception as error:
        raise _error(503, "content_identity_unavailable", "Content is temporarily unavailable. Retry shortly.") from error


def read_content_context(content_id: str) -> ContentContext:
    try:
        settings = get_settings()
        version = settings.analysis_version
        repository = get_supabase_repository()
        content = _public_content(content_id, repository, settings)
        if repository is not None and settings.queue_is_configured:
            blueprint = repository.get_blueprint(content_id, version)
            job = repository.find_job(content_id, version)
        elif settings.queue_is_configured:
            blueprint = processing_queue.get_blueprint(content_id, version)
            job = processing_queue.find_job(content_id, version)
        else:
            blueprint = store.blueprints.get(content_id)
            job = next((job for job in store.jobs.values() if job.content_id == content_id and job.analysis_version == version), None)
        return ContentContext(content=content,
            processing=ContentProcessing(analysis_version=version,
                blueprint_available=bool(blueprint and blueprint.content_id == content_id and blueprint.analysis_version == version),
                job=ContentJobSummary.model_validate(job.model_dump()) if job else None))
    except HTTPException:
        raise
    except Exception as error:
        raise _error(503, "content_context_unavailable", "Content is temporarily unavailable. Retry shortly.") from error
