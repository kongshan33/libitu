"""Small CAS operations shared by HTTP and long-lived speaking connections."""

import base64
import copy
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException

from app.config import get_settings
from app.integrations.speaking_runtime_repository import RuntimeConflict, get_runtime_store
from app.schemas.speaking_runtime import RealtimeStart, RealtimeTicket, SpeakingWorkspace
from app.services.speaking_service import get_speaking_session


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return now().isoformat()


def future(seconds: float) -> str:
    return (now() + timedelta(seconds=seconds)).isoformat()


def is_future(value: str | None) -> bool:
    try:
        return datetime.fromisoformat(value or "") > now()
    except (ValueError, TypeError):
        return False


def require_session(owner: str, session_id: str):
    session = get_speaking_session(owner, session_id)
    if session is None:
        raise HTTPException(404, "Speaking mission not found.")
    return session


def read_state(owner: str, session_id: str) -> dict:
    result = get_runtime_store().read(owner, session_id)
    if result is None:
        raise HTTPException(404, "Speaking mission not found.")
    return result


def mutate(owner: str, session_id: str, operation, runtime_id: str | None = None) -> dict:
    """No awaits/model calls in operation: replay on a CAS conflict is safe."""
    store = get_runtime_store()
    for _ in range(6):
        state = read_state(owner, session_id)
        document = copy.deepcopy(state["document"])
        if runtime_id:
            runtime = document.get("runtime") or {}
            if (state["status"] in ("completed", "abandoned") or runtime.get("id") != runtime_id
                    or runtime.get("state") == "disconnected" or not is_future(runtime.get("expires_at"))):
                raise HTTPException(409, "This connection is no longer active. Reconnect to continue.")
        document.setdefault("messages", [])
        document.setdefault("evidence", [])
        document.setdefault("learning", [])
        document.setdefault("analysis_status", "idle")
        next_status = operation(document, state) or state["status"]
        count = sum(m["role"] == "user" and m["status"] == "final" and bool(m["text"].strip())
                    for m in document["messages"])
        try:
            result = store.compare_and_swap(owner, session_id, state["version"], document, next_status, count)
        except RuntimeConflict:
            continue
        if result is None:
            raise HTTPException(404, "Speaking mission not found.")
        return result
    raise HTTPException(409, "This mission changed in another window. Please retry.")


def public_workspace(owner: str, session_id: str, state: dict | None = None) -> SpeakingWorkspace:
    session = require_session(owner, session_id)
    state = state if state is not None else read_state(owner, session_id)
    session.status = state["status"]
    session.turn_count = state["turn_count"]
    document = state["document"]
    runtime = copy.deepcopy(document.get("runtime"))
    if runtime and not is_future(runtime.get("expires_at")):
        runtime["state"] = "disconnected"
    return SpeakingWorkspace.model_validate({
        "session": session, "version": state["version"], "runtime": runtime,
        **{key: document[key] for key in ("messages", "evidence", "learning", "policy", "analysis_status", "hint")
           if key in document},
    })


def expire_policy(document: dict) -> None:
    policy = document.get("policy")
    if policy and policy.get("status") == "pending":
        policy["status"] = "expired"


def interrupt_unheard(document: dict) -> None:
    pending = set(document.pop("playback_pending", []))
    for message in document.get("messages", []):
        if message.get("response_id") in pending and message["role"] == "assistant":
            message["status"] = "interrupted"


def create_ticket(owner: str, session_id: str, payload: RealtimeStart) -> RealtimeTicket:
    require_session(owner, session_id)
    settings = get_settings()
    if not (settings.gemini_api_key if settings.speaking_realtime_provider == "gemini" else settings.openai_api_key):
        raise HTTPException(503, "Real-time conversation is not configured. Your mission is saved.")
    runtime_id = str(uuid4())
    # The owner claim is untrusted until the entire one-use bearer is checked
    # against its database hash. It is never accepted as authentication alone.
    ticket = base64.urlsafe_b64encode(json.dumps([owner, secrets.token_urlsafe(32)]).encode()).decode()
    expires = future(30)

    def claim(document, state):
        if state["status"] in ("completed", "abandoned"):
            raise HTTPException(409, "This mission has ended. Start a new mission from your loadout.")
        if sum(m["role"] == "user" for m in document["messages"]) >= get_settings().speaking_max_turns:
            raise HTTPException(409, "This mission reached its turn limit. End it to review your conversation.")
        previous = document.get("runtime") or {}
        if previous.get("state") != "disconnected" and is_future(previous.get("expires_at")) and not payload.takeover:
            raise HTTPException(409, "This mission is open in another connection. Take over to continue here.")
        interrupt_unheard(document)
        generation = document.get("generation", 0) + 1
        document["generation"] = generation
        document["runtime"] = {
            "id": runtime_id, "generation": generation, "state": "connecting", "expires_at": expires,
            "ticket_hash": hashlib.sha256(ticket.encode()).hexdigest(), "ticket_expires_at": expires,
            "ticket_used": False, "client_connection_id": str(payload.client_connection_id),
        }
        expire_policy(document)
        if document.get("analysis_status") == "pending":
            document["analysis_status"] = "unavailable"
        return "active"

    mutate(owner, session_id, claim)
    return RealtimeTicket(runtime_id=runtime_id, ticket=ticket, expires_at=expires,
                          websocket_path=f"/api/speaking/sessions/{session_id}/realtime/{runtime_id}")


def consume_ticket(session_id: str, runtime_id: str, ticket: str) -> str:
    try:
        if len(ticket) > 2048:
            raise ValueError
        owner, nonce = json.loads(base64.urlsafe_b64decode(ticket))
        if not isinstance(owner, str) or not owner or not isinstance(nonce, str):
            raise ValueError
    except (ValueError, TypeError, UnicodeDecodeError):
        raise HTTPException(401, "Reconnect to obtain a new connection ticket.") from None

    def consume(document, _state):
        runtime = document["runtime"]
        digest = hashlib.sha256(ticket.encode()).hexdigest()
        if (runtime.get("ticket_used") or not is_future(runtime.get("ticket_expires_at"))
                or not hmac.compare_digest(runtime.get("ticket_hash", ""), digest)):
            raise HTTPException(401, "Reconnect to obtain a new connection ticket.")
        runtime["ticket_used"] = True
        runtime.pop("ticket_hash", None)
        runtime["expires_at"] = future(get_settings().speaking_lease_seconds)

    mutate(owner, session_id, consume, runtime_id)
    return owner


def disconnect_runtime(owner: str, session_id: str, runtime_id: str) -> None:
    def release(document, _state):
        interrupt_unheard(document)
        document["runtime"]["state"] = "disconnected"
        document["runtime"]["expires_at"] = iso_now()
        expire_policy(document)
        if document.get("analysis_status") == "pending":
            document["analysis_status"] = "unavailable"
    try:
        mutate(owner, session_id, release, runtime_id)
    except HTTPException as error:
        if error.status_code not in (404, 409):
            raise


def end_session(owner: str, session_id: str) -> SpeakingWorkspace:
    def end(document, _state):
        interrupt_unheard(document)
        runtime = document.get("runtime")
        if runtime:
            runtime.update(state="disconnected", expires_at=iso_now())
            runtime.pop("ticket_hash", None)
        expire_policy(document)
        if document.get("analysis_status") == "pending":
            document["analysis_status"] = "unavailable"
        return "completed" if _state["status"] != "abandoned" else "abandoned"
    return public_workspace(owner, session_id, mutate(owner, session_id, end))


def delete_session(owner: str, session_id: str) -> None:
    if not get_runtime_store().delete(owner, session_id):
        raise HTTPException(404, "Speaking mission not found.")
