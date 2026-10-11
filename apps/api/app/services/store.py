from app.schemas.blueprint import Blueprint
from app.schemas.captions import CaptionTrack
from app.schemas.content import ContentResolveResponse
from app.schemas.corpus import CorpusItem
from app.schemas.job import ProcessingJob
from app.schemas.speaking import SpeakingSession

contents: dict[str, ContentResolveResponse] = {}
content_transcripts: dict[str, str] = {}
content_caption_tracks: dict[str, CaptionTrack] = {}
jobs: dict[str, ProcessingJob] = {}
blueprints: dict[str, Blueprint] = {}
corpus_items: dict[str, CorpusItem] = {}
speaking_sessions: dict[str, SpeakingSession] = {}
speaking_session_submissions: dict[tuple[str, str], tuple[dict, str]] = {}

# Explicit authenticated video visits; inline development only.
content_visits: dict[tuple[str, str], str] = {}
