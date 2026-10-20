"""Private, append-only teaching traces, separate from the realtime document."""

import json
import re
from datetime import datetime, timedelta, timezone
from threading import RLock
from typing import Protocol
from uuid import UUID

import httpx
from fastapi import HTTPException

from app.config import get_settings
from app.integrations.supabase_repository import SupabaseRepository, get_supabase_repository
from app.services import store

MAX_PAYLOAD_BYTES = 128 * 1024
MAX_PAGE_EVENTS = 200
RETENTION_DAYS = 30
_KIND = re.compile(r"[a-z][a-z0-9_.-]{0,79}\Z")
_FORBIDDEN_KEYS = {
    "authorization", "api_key", "apikey", "access_token", "refresh_token", "secret_key",
    "service_role_key", "ticket", "ticket_hash", "token",
}


def _invalid() -> HTTPException:
    return HTTPException(status_code=422, detail="Invalid speaking diagnostic event or cursor.")


def _unavailable() -> HTTPException:
    return HTTPException(status_code=503, detail="Speaking diagnostics are unavailable. Please retry.")


def _uuid(value: object) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise _invalid() from None


def _identity(owner: str, session_id: str) -> str:
    if not isinstance(owner, str) or not owner.strip():
        raise _invalid()
    return _uuid(session_id)


def _json_value(value: object) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in _FORBIDDEN_KEYS:
                raise _invalid()
            _json_value(key)
            _json_value(item)
    elif isinstance(value, list):
        for item in value:
            _json_value(item)
    elif isinstance(value, str):
        if "\x00" in value:
            raise _invalid()
    elif value is not None and type(value) not in (bool, int, float):
        raise _invalid()


def validate_event(event: dict) -> dict:
    """Copy JSON and reject transport credentials and invalid PostgreSQL JSON."""
    if not isinstance(event, dict) or set(event) != {"id", "kind", "created_at", "payload"}:
        raise _invalid()
    kind, payload = event["kind"], event["payload"]
    if not isinstance(kind, str) or not _KIND.fullmatch(kind) or not isinstance(payload, dict):
        raise _invalid()
    try:
        _json_value(payload)
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_PAYLOAD_BYTES:
            raise _invalid()
        timestamp = datetime.fromisoformat(event["created_at"].replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise _invalid()
        timestamp = timestamp.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError, UnicodeError, RecursionError, OverflowError):
        raise _invalid() from None
    return {"id": _uuid(event["id"]), "kind": kind, "created_at": timestamp.isoformat(),
            "payload": json.loads(encoded)}


def _pagination(limit: int, before: str | None) -> str | None:
    if type(limit) is not int or not 1 <= limit <= MAX_PAGE_EVENTS:
        raise _invalid()
    return _uuid(before) if before is not None else None


def _page(value: object, limit: int) -> dict | None:
    if value is None:
        return None
    if (not isinstance(value, dict) or set(value) != {"events", "limit", "next_before"}
            or type(value["limit"]) is not int or value["limit"] != limit
            or not isinstance(value["events"], list) or len(value["events"]) > limit):
        raise _unavailable()
    try:
        events = [validate_event(event) for event in value["events"]]
        cursor = _uuid(value["next_before"]) if value["next_before"] is not None else None
        if cursor is not None and (not events or cursor != events[-1]["id"]):
            raise _invalid()
    except HTTPException:
        raise _unavailable() from None
    return {"events": events, "limit": limit, "next_before": cursor}


class DiagnosticsStore(Protocol):
    def append(self, owner: str, session_id: str, event: dict) -> bool | None: ...

    def read(self, owner: str, session_id: str, limit: int, before: str | None) -> dict | None: ...


class SupabaseDiagnosticsStore:
    def __init__(self, database: SupabaseRepository) -> None:
        self.database = database

    def _rpc(self, name: str, payload: dict):
        try:
            return self.database._request("POST", f"/rpc/{name}", json=payload).json()
        except httpx.HTTPStatusError as exc:
            try:
                error = exc.response.json()
                code = error.get("code") if isinstance(error, dict) else None
            except ValueError:
                code = None
            if code == "PT422":
                raise _invalid() from None
            raise _unavailable() from None
        except (httpx.RequestError, ValueError, TypeError):
            raise _unavailable() from None

    def append(self, owner: str, session_id: str, event: dict) -> bool | None:
        session_id = _identity(owner, session_id)
        event = validate_event(event)
        result = self._rpc("append_speaking_diagnostic", {
            "p_user_id": owner, "p_session_id": session_id, "p_event": event,
        })
        if result is not None and type(result) is not bool:
            raise _unavailable()
        return result

    def read(self, owner: str, session_id: str, limit: int = MAX_PAGE_EVENTS,
             before: str | None = None) -> dict | None:
        session_id = _identity(owner, session_id)
        before = _pagination(limit, before)
        return _page(self._rpc("read_speaking_diagnostics", {
            "p_user_id": owner, "p_session_id": session_id, "p_limit": limit, "p_before": before,
        }), limit)


class InlineDiagnosticsStore:
    def __init__(self) -> None:
        self._lock = RLock()
        self._events: dict[str, dict[str, dict]] = {}

    def _owned(self, owner: str, session_id: str) -> bool:
        session = store.speaking_sessions.get(session_id)
        return session is not None and session.user_id == owner and session.client_id is not None

    def purge(self, session_id: str) -> None:
        with self._lock:
            self._events.pop(session_id, None)

    def _prune(self, session_id: str) -> dict[str, dict]:
        now = datetime.now(timezone.utc)
        events = self._events.get(session_id, {})
        for event_id in list(events):
            if events[event_id]["expires_at"] <= now:
                del events[event_id]
        return events

    def append(self, owner: str, session_id: str, event: dict) -> bool | None:
        session_id = _identity(owner, session_id)
        event = validate_event(event)
        with self._lock:
            if not self._owned(owner, session_id):
                return None
            events = self._prune(session_id)
            if event["id"] in events:
                return False
            events[event["id"]] = {"event": event, "expires_at": datetime.now(timezone.utc)
                                    + timedelta(days=RETENTION_DAYS)}
            self._events[session_id] = events
            return True

    def read(self, owner: str, session_id: str, limit: int = MAX_PAGE_EVENTS,
             before: str | None = None) -> dict | None:
        session_id = _identity(owner, session_id)
        before = _pagination(limit, before)
        with self._lock:
            if not self._owned(owner, session_id):
                return None
            events = self._prune(session_id)
            ordered = sorted((row["event"] for row in events.values()),
                             key=lambda event: (event["created_at"], event["id"]), reverse=True)
            if before is not None:
                if before not in events:
                    raise _invalid()
                cursor = events[before]["event"]
                ordered = [event for event in ordered
                           if (event["created_at"], event["id"]) < (cursor["created_at"], cursor["id"])]
            page = ordered[:limit]
            return _page({"events": page, "limit": limit,
                          "next_before": page[-1]["id"] if len(ordered) > limit else None}, limit)


_inline_diagnostics_store = InlineDiagnosticsStore()


def purge_inline_diagnostics(session_id: str) -> None:
    _inline_diagnostics_store.purge(session_id)


def get_diagnostics_store() -> DiagnosticsStore:
    try:
        database = get_supabase_repository()
    except (httpx.HTTPError, ValueError):
        raise _unavailable() from None
    if database is not None:
        return SupabaseDiagnosticsStore(database)
    settings = get_settings()
    if settings.supabase_server_is_configured or settings.processing_mode != "inline":
        raise _unavailable()
    return _inline_diagnostics_store
