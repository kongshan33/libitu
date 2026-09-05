from app.schemas.blueprint import Blueprint
from app.schemas.content import ContentResolveResponse
from app.schemas.corpus import CorpusItem
from app.schemas.job import ProcessingJob
from app.schemas.speaking import SpeakingSession

contents: dict[str, ContentResolveResponse] = {}
content_transcripts: dict[str, str] = {}
jobs: dict[str, ProcessingJob] = {}
blueprints: dict[str, Blueprint] = {}
corpus_items: dict[str, CorpusItem] = {}
speaking_sessions: dict[str, SpeakingSession] = {}
