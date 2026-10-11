"""Bounded read-only projections; every private table is filtered by its owner."""

from dataclasses import dataclass, field
from datetime import datetime
from time import monotonic

import httpx
from fastapi import HTTPException

from app.config import get_settings
from app.integrations.speaking_feedback_repository import _inline_feedback_store
from app.integrations.speaking_runtime_repository import get_runtime_store
from app.integrations.supabase_repository import SupabaseRepository, get_supabase_repository
from app.services import store

PAGE_SIZE = 500
MAX_ROWS = 50000
READ_BUDGET_SECONDS = 15
FEEDBACK_PROJECTION = (
    "speaking_feedback(id,session_id,status,rubric_version,analysis_version,created_at,updated_at,"
    "dimensions:result->dimensions)"
)


def unavailable() -> HTTPException:
    return HTTPException(503, "Learning activity could not be loaded. Please retry.",
                         headers={"Cache-Control": "private, no-store"})


@dataclass
class ProfileRecords:
    attempts: list[dict] = field(default_factory=list)
    sessions: list[dict] = field(default_factory=list)
    corpus: list[dict] = field(default_factory=list)
    videos: list[dict] = field(default_factory=list)


class ProfileRepository:
    def __init__(self, database: SupabaseRepository) -> None:
        self.database = database

    def _rows(self, table: str, owner: str, selection: str, now: datetime,
              deadline: float, **filters: str) -> list[dict]:
        rows: list[dict] = []
        seen: set[str] = set()
        total: int | None = None
        while True:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise unavailable()
            response = self.database._request("GET", f"/{table}", params={
                "user_id": f"eq.{owner}", "select": selection,
                "created_at": f"lte.{now.isoformat()}", "order": "created_at.desc,id.desc",
                "offset": str(len(rows)), "limit": str(PAGE_SIZE), **filters,
            }, headers={"Prefer": "count=exact"})
            # The shared HTTP client also bounds each request to ten seconds.
            if monotonic() > deadline:
                raise unavailable()
            page = response.json()
            if not isinstance(page, list) or any(not isinstance(row, dict) for row in page):
                raise unavailable()
            # A project can impose a lower cap than PAGE_SIZE. Advance by the
            # actual count; only an empty page or the exact total ends the scan.
            count = response.headers.get("content-range", "").rsplit("/", 1)[-1]
            if count.isdigit():
                current_total = int(count)
                if current_total > MAX_ROWS or total is not None and total != current_total:
                    raise unavailable()
                total = current_total
            for row in page:
                identity = row.get("id")
                if not isinstance(identity, str) or identity in seen or row.get("user_id") != owner:
                    raise unavailable()
                seen.add(identity)
            rows.extend(page)
            if len(rows) > MAX_ROWS or total is not None and len(rows) > total:
                raise unavailable()
            if total is not None and len(rows) == total:
                return rows
            if not page:
                if total is not None and len(rows) != total:
                    raise unavailable()
                return rows

    def read(self, owner: str, now: datetime, *, include_corpus: bool = True) -> ProfileRecords:
        deadline = monotonic() + READ_BUDGET_SECONDS
        attempts = self._rows("shadow_attempts", owner,
            "id,user_id,content_id,sentence_id,sentence_text,start_ms,duration_ms,created_at,"
            "deleted_at,contents(kind,title,source_url,visibility,owner_user_id)", now, deadline, deleted_at="is.null")
        sessions = self._rows("speaking_sessions", owner,
            "id,user_id,goal,scenario_type,difficulty,status,created_at,turn_count,"
            "speaking_runtime_state(messages:document->messages)," + FEEDBACK_PROJECTION,
            now, deadline, client_id="not.is.null")
        corpus = self._rows("corpus_items", owner, "id,user_id,kind,created_at,content_id,contents(kind,title,source_url,visibility,owner_user_id)", now, deadline) if include_corpus else []
        videos = self._rows("user_content_states", owner,
            "id:content_id,user_id,content_id,created_at,last_opened_at,"
            "contents(kind,title,source_url,visibility,owner_user_id)", now, deadline,
            order="last_opened_at.desc,content_id.desc")
        return ProfileRecords(attempts, sessions, corpus, videos)


def read_profile_records(owner: str, now: datetime, *, include_corpus: bool = True) -> ProfileRecords:
    try:
        database = get_supabase_repository()
        if database is not None:
            return ProfileRepository(database).read(owner, now, include_corpus=include_corpus)
        settings = get_settings()
        if settings.supabase_server_is_configured or settings.processing_mode != "inline":
            raise unavailable()
        # Practice recording persistence has no inline success fallback. Reflect
        # the real local corpus and speaking stores; never seed profile fixtures.
        sessions = []
        runtime = get_runtime_store()
        feedback = _inline_feedback_store.profile_summaries(owner)
        for session in list(store.speaking_sessions.values()):
            if session.user_id != owner:
                continue
            state = runtime.read(owner, str(session.id))
            if state is None:
                continue
            sessions.append({**session.model_dump(mode="json"),
                "speaking_runtime_state": {"messages": state["document"].get("messages", [])},
                "speaking_feedback": feedback.get(str(session.id))})
        corpus = [item.model_dump(mode="json") for item in list(store.corpus_items.values())
                  if item.user_id == owner] if include_corpus else []
        videos = []
        for (user_id, content_id), opened in list(store.content_visits.items()):
            content = store.contents.get(content_id)
            if user_id == owner and content is not None:
                videos.append({"id": content_id, "user_id": owner, "content_id": content_id,
                    "last_opened_at": opened, "contents": {**content.model_dump(mode="json"),
                    "visibility": "public", "owner_user_id": None}})
        for row in corpus:
            content = store.contents.get(str(row.get("content_id")))
            if content is not None:
                row["contents"] = {**content.model_dump(mode="json"), "visibility": "public", "owner_user_id": None}
        return ProfileRecords(sessions=sessions, corpus=corpus, videos=videos)
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        raise unavailable() from None
