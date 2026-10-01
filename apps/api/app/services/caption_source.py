"""Caption provenance and reload support, separate from semantic analysis/media."""

from hashlib import sha256
import logging
import re

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.captions import CaptionTrack
from app.services import store
from app.services.transcript_formatter import filter_filler_tokens, parse_transcript


logger = logging.getLogger(__name__)


def caption_fingerprint(track: CaptionTrack) -> str:
    return sha256(track.model_dump_json(exclude_none=True).encode()).hexdigest()


def transcript_signature(text: str) -> tuple[str, ...]:
    """Compare spoken text, not caption wrapping, punctuation or timestamp precision."""
    lines = filter_filler_tokens(parse_transcript(text, preserve_rows=True))
    text = " ".join(line.text for line in lines).casefold().replace("’", "'")
    return tuple(re.findall(r"\w+(?:'\w+)*", text))


def get_caption_track(content_id: str, *, include_durable: bool = True) -> CaptionTrack | None:
    track = store.content_caption_tracks.get(content_id)
    if track is not None:
        return track
    if not get_settings().queue_is_configured:
        return None
    try:
        queued = processing_queue.get_content(content_id)
        if (queued is None or queued.caption_track is None) and include_durable:
            repository = get_supabase_repository()
            queued = repository.get_content(content_id) if repository is not None else None
    except Exception as error:
        # This is an optional enhancement to an already loaded blueprint. Keep
        # its existing captions available when a source/cache read is unhealthy.
        # Exception messages can include credentials or signed request URLs.
        logger.warning("Optional caption timing read failed: %s", type(error).__name__)
        return None
    if queued is not None and queued.caption_track is not None:
        return queued.caption_track
    return None
