import math

from youtube_transcript_api import YouTubeTranscriptApi

from app.schemas.captions import CaptionEvent, CaptionSegment, CaptionTrack
from app.services.transcript_formatter import caption_track_to_text, format_timestamp_ms

class TranscriptUnavailableError(RuntimeError):
    pass


def fetch_youtube_transcript(video_id: str, language: str | None = None) -> str:
    """Compatibility adapter retaining millisecond starts in the plain text."""
    return caption_track_to_text(fetch_youtube_caption_track(video_id, language))


def fetch_youtube_caption_track(video_id: str, language: str | None = None) -> CaptionTrack:
    languages = _language_preferences(language)
    try:
        fetched = YouTubeTranscriptApi().fetch(video_id, languages=languages)
    except Exception as error:
        raise TranscriptUnavailableError(
            "YouTube captions are unavailable from both the browser and transcript provider."
        ) from error

    try:
        events = []
        for snippet in fetched:
            if not snippet.text.strip():
                continue
            start = float(snippet.start)
            duration = getattr(snippet, "duration", None)
            if not math.isfinite(start) or start < 0:
                raise ValueError("Invalid caption start.")
            if duration is not None and (not math.isfinite(float(duration)) or float(duration) < 0):
                raise ValueError("Invalid caption duration.")
            events.append(CaptionEvent(
                tStartMs=round(start * 1000),
                dDurationMs=round(float(duration) * 1000) if duration is not None else None,
                segs=[CaptionSegment(utf8=snippet.text)],
            ))
        generated = getattr(fetched, "is_generated", None)
        track = CaptionTrack(
            version="youtube-snippets-v1", video_id=video_id,
            language=getattr(fetched, "language_code", language),
            kind="asr" if generated is True else "manual" if generated is False else "unknown",
            events=events,
        )
    except (ValueError, TypeError, AttributeError) as error:
        raise TranscriptUnavailableError("YouTube returned invalid caption timing.") from error
    if not events:
        raise TranscriptUnavailableError("YouTube returned an empty transcript.")
    return track


def _language_preferences(language: str | None) -> list[str]:
    if not language:
        return ["en", "en-US", "en-GB"]
    base = language.split("-")[0]
    return list(dict.fromkeys([language, base, "en", "en-US", "en-GB"]))


def _format_timestamp(start_seconds: float) -> str:
    return format_timestamp_ms(round(start_seconds * 1000))
