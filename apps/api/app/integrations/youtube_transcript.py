from youtube_transcript_api import YouTubeTranscriptApi


class TranscriptUnavailableError(RuntimeError):
    pass


def fetch_youtube_transcript(video_id: str, language: str | None = None) -> str:
    languages = _language_preferences(language)
    try:
        fetched = YouTubeTranscriptApi().fetch(video_id, languages=languages)
    except Exception as error:
        raise TranscriptUnavailableError(
            "YouTube captions are unavailable from both the browser and transcript provider."
        ) from error

    lines = [
        f"{_format_timestamp(float(snippet.start))}\t{snippet.text.replace(chr(10), ' ').strip()}"
        for snippet in fetched
        if snippet.text.strip()
    ]
    if not lines:
        raise TranscriptUnavailableError("YouTube returned an empty transcript.")
    return "\n".join(lines)


def _language_preferences(language: str | None) -> list[str]:
    if not language:
        return ["en", "en-US", "en-GB"]
    base = language.split("-")[0]
    return list(dict.fromkeys([language, base, "en", "en-US", "en-GB"]))


def _format_timestamp(start_seconds: float) -> str:
    total_seconds = max(0, int(start_seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"
