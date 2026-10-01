"""Restore missing caption timing without changing semantic analysis or jobs."""

import logging
from hashlib import sha256
from threading import Lock
from typing import NoReturn
from urllib.parse import parse_qs, urlparse

from app.config import get_settings
from app.integrations import processing_queue
from app.integrations.processing_queue import QueuedContent
from app.integrations.supabase_repository import get_supabase_repository
from app.schemas.analysis import LearnerLevel
from app.schemas.blueprint import Blueprint, TranscriptLine
from app.schemas.caption_recovery import CaptionTimingResponse
from app.schemas.captions import CaptionTrack
from app.schemas.content import ContentKind
from app.services import store
from app.services.blueprint_service import build_caption_timing_view, personalize_blueprint
from app.services.caption_source import caption_fingerprint
from app.services.transcript_formatter import caption_track_matches_text


logger = logging.getLogger(__name__)
# Bounded lock storage, independent of attacker-supplied content IDs.
_locks = tuple(Lock() for _ in range(64))
_MAX_HIGHLIGHT_INTERVAL_MS = 2000


class CaptionRecoveryError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def recover_caption_timing(
    content_id: str, track: CaptionTrack, learner_level: LearnerLevel | None = None,
) -> CaptionTimingResponse:
    lock = _locks[int.from_bytes(sha256(content_id.encode()).digest()[:2]) % len(_locks)]
    with lock:
        return _recover(content_id, track, learner_level)


def _recover(content_id: str, track: CaptionTrack, learner_level: LearnerLevel | None) -> CaptionTimingResponse:
    settings = get_settings()
    try:
        repository = get_supabase_repository()
        if repository is not None:
            # Durable state wins over a stale process/Redis cache, including a
            # previous attempt whose write succeeded but response was lost.
            source = repository.get_content(content_id)
            blueprint = repository.get_blueprint(content_id, settings.analysis_version) if source else None
        elif settings.processing_mode == "queue":
            raise RuntimeError("Timing recovery requires durable storage in queue mode.")
        else:
            content = store.contents.get(content_id)
            source = QueuedContent(content, store.content_transcripts.get(content_id),
                                   store.content_caption_tracks.get(content_id)) if content else None
            blueprint = store.blueprints.get(content_id)
    except Exception as error:
        _storage_failure(error)
    if source is None:
        raise CaptionRecoveryError(404, "content_not_found", "The existing content was not found.")
    if blueprint is None or blueprint.analysis_version != settings.analysis_version:
        raise CaptionRecoveryError(409, "caption_blueprint_unavailable", "A completed current-version blueprint is required; no analysis was started.")
    _validate_source(content_id, source, blueprint, track)
    text = "\n".join(_line_text(line) for line in blueprint.transcript)
    if not source.transcript_text or not caption_track_matches_text(track, source.transcript_text, track.language) or not caption_track_matches_text(track, text, track.language):
        raise CaptionRecoveryError(409, "caption_text_mismatch", "These captions do not match the complete existing transcript. No timing was changed.")
    if track.version != "youtube-json3-v1":
        raise CaptionRecoveryError(409, "caption_timing_unavailable", "These captions do not contain usable JSON3 word timing.")

    # Pure preflight: do not publish source or derived cache state until both
    # source comparisons and actual highlight capability have been validated.
    candidate = _build_view(blueprint, track)
    incoming = _usable_words(candidate)
    if not incoming:
        raise CaptionRecoveryError(409, "caption_timing_unavailable", "These captions have no usable word intervals. Existing listening remains available.")
    previous_track = source.caption_track
    existing = blueprint
    if previous_track is not None:
        try:
            _validate_source(content_id, source, blueprint, previous_track)
        except CaptionRecoveryError:
            previous_track = None
        if previous_track is not None and (
            not caption_track_matches_text(previous_track, text, track.language)
            or not caption_track_matches_text(previous_track, source.transcript_text, track.language)
        ):
            previous_track = None
    if previous_track is not None:
        existing = candidate if caption_fingerprint(previous_track) == caption_fingerprint(track) else _build_view(blueprint, previous_track)
    previous = _usable_words(existing)
    # Do not replace valid timing just because a new track has different times.
    # Improvement must add coverage and preserve every previously usable token.
    improved = previous < incoming
    selected_track = track if improved else previous_track
    selected_view = candidate if improved else existing

    try:
        if improved and repository is not None:
            repository.save_caption_source(content_id, source.transcript_text, track)
        if settings.queue_is_configured and selected_track is not None:
            # Repeating a confirmed request also repairs failed Redis publication.
            processing_queue.save_content(source.content, source.transcript_text, selected_track)
    except Exception as error:
        # No fabricated rollback: an RPC may have committed before a timeout.
        # Retry reads durable state; optional GET can recover a missing Redis track.
        _storage_failure(error)
    if selected_track is not None:
        store.content_caption_tracks[content_id] = selected_track
    return CaptionTimingResponse(
        status="updated" if improved else "unchanged",
        blueprint=personalize_blueprint(selected_view, learner_level),
    )


def _validate_source(content_id: str, source: QueuedContent, blueprint: Blueprint, track: CaptionTrack) -> None:
    content = source.content
    language = (track.language or "").lower().split("-")[0]
    previous_language = (content.language or "").lower().split("-")[0]
    if (
        content.kind != ContentKind.youtube or content.content_id != content_id
        or blueprint.content_id != content_id or content.normalized_key != f"youtube:{track.video_id}"
        or _video_id(content.source_url) != track.video_id
        or _video_id(blueprint.source_url) != track.video_id
        or language != "en" or (previous_language and previous_language != language)
    ):
        raise CaptionRecoveryError(409, "caption_source_mismatch", "Caption video, source or language does not match this English YouTube content.")


def _video_id(url: str | None) -> str | None:
    parsed = urlparse(url or "")
    host = (parsed.hostname or "").lower()
    if host == "youtu.be":
        return parsed.path.strip("/")
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        return parse_qs(parsed.query).get("v", [None])[0]
    return None


def _line_text(line: TranscriptLine) -> str:
    return "".join(part if isinstance(part, str) else part.text for part in line.parts)


def _usable_words(blueprint: Blueprint) -> set[tuple[int, str]]:
    """Mirror the UI's conservative 2-second interval and exact-token gate.

    SentenceMetadata already requires strictly increasing, nonoverlapping starts
    and valid provenance. Normalize comparison case/punctuation only after the
    timing has matched its own displayed whitespace token exactly.
    """
    from app.services.caption_source import transcript_signature

    usable: set[tuple[int, str]] = set()
    for row in blueprint.transcript:
        if row.timing_source != "caption_word_offsets" or row.source_token_start is None:
            continue
        tokens = _line_text(row).split()
        for word in row.word_timings or []:
            index = word.source_token_index - row.source_token_start
            if (0 <= index < len(tokens) and tokens[index] == word.text
                and word.end_ms is not None and word.end_source is not None
                and 0 < word.end_ms - word.start_ms <= _MAX_HIGHLIGHT_INTERVAL_MS):
                usable.add((word.source_token_index, " ".join(transcript_signature(word.text))))
    return usable


def _build_view(blueprint: Blueprint, track: CaptionTrack) -> Blueprint:
    try:
        return build_caption_timing_view(blueprint, track)
    except Exception as error:
        logger.warning("Caption timing preparation failed: %s", type(error).__name__)
        raise CaptionRecoveryError(503, "caption_processing_unavailable", "Word timing could not be prepared. No source or analysis was changed; retry safely.") from error


def _storage_failure(error: Exception) -> NoReturn:
    logger.warning("Caption timing storage failed: %s", type(error).__name__)
    raise CaptionRecoveryError(503, "caption_storage_unavailable", "Timing storage could not be confirmed. It may already have been saved; retry safely without reanalysis.") from error
