"""Synchronous diagnostics operations; realtime callers must run them in the background."""

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from app.integrations.speaking_diagnostics_repository import get_diagnostics_store


def new_event(kind: str, payload: dict) -> dict:
    return {"id": str(uuid4()), "kind": kind, "created_at": datetime.now(timezone.utc).isoformat(),
            "payload": payload}


def append_event(owner: str, session_id: str, event: dict) -> bool:
    """Append once by event ID. Never mutate session status or the runtime version."""
    result = get_diagnostics_store().append(owner, session_id, event)
    if result is None:
        raise HTTPException(status_code=404, detail="Speaking session not found.")
    return result


def read_events(owner: str, session_id: str, limit: int = 200, before: str | None = None) -> dict:
    """Newest first, with an exclusive event-ID cursor for the next older page."""
    result = get_diagnostics_store().read(owner, session_id, limit, before)
    if result is None:
        raise HTTPException(status_code=404, detail="Speaking session not found.")
    return result
