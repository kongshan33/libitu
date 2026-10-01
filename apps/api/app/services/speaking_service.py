from datetime import datetime, timezone
from threading import RLock
from typing import Callable, TypeVar
from uuid import uuid4

import httpx
from fastapi import HTTPException
from pydantic import ValidationError

from app.config import get_settings
from app.integrations.speaking_repository import SpeakingRepository, get_speaking_repository
from app.schemas.speaking import (
    LogicTemplate, SpeakingOptions, SpeakingSession, SpeakingSessionCreate, SpeakingSessionItem,
    SpeakingTurnCreate, SpeakingTurnResponse,
)
from app.services import store


_LOGIC_TEMPLATES = (
    LogicTemplate(id="persuasive_pitch", title="Persuasive pitch", description="Make a case under pushback",
                  steps=["Context", "Tension", "Proposal", "Defend"]),
    LogicTemplate(id="technical_troubleshoot", title="Technical troubleshoot", description="Diagnose and explain a problem",
                  steps=["Symptom", "Cause", "Fix", "Confirm"]),
    LogicTemplate(id="stakeholder_alignment", title="Stakeholder alignment", description="Navigate competing priorities",
                  steps=["Context", "Stakes", "Trade-off", "Commit"]),
    LogicTemplate(id="status_update", title="Status update", description="Report progress, flag risks",
                  steps=["Done", "Blockers", "Next", "Ask"]),
    LogicTemplate(id="disagreement", title="Disagreement", description="Push back constructively",
                  steps=["Acknowledge", "Reframe", "Evidence", "Propose"]),
    LogicTemplate(id="onboarding", title="Onboarding someone", description="Explain a complex system",
                  steps=["Big picture", "Parts", "Why", "Try it"]),
)
_MEMORY_LOCK = RLock()
_Result = TypeVar("_Result")
_PERSISTENCE_ERROR = "Speaking sessions could not be saved or loaded. Please retry."
_RPC_ERRORS = {
    "PT404": (404, "One or more selected corpus items are unavailable. Refresh your library and try again."),
    "PT409": (409, "This submission ID already belongs to a different loadout. Start a new submission."),
    "PT422": (422, "Choose at least one item, with up to three structures and five expressions."),
}


def speaking_options() -> SpeakingOptions:
    return SpeakingOptions(logic_templates=[item.model_copy(deep=True) for item in _LOGIC_TEMPLATES])


def _repository() -> SpeakingRepository | None:
    repository = get_speaking_repository()
    settings = get_settings()
    if repository is None and (settings.processing_mode != "inline" or settings.supabase_server_is_configured):
        raise HTTPException(status_code=503, detail="Speaking session storage is not configured.")
    return repository


def _call(operation: Callable[..., _Result], *args) -> _Result:
    try:
        return operation(*args)
    except httpx.HTTPStatusError as error:
        try:
            document = error.response.json()
            code = document.get("code") if isinstance(document, dict) else None
        except ValueError:
            code = None
        status, detail = _RPC_ERRORS.get(code if isinstance(code, str) else None, (503, _PERSISTENCE_ERROR))
        # Never return database details, request contents, or provider diagnostics.
        raise HTTPException(status_code=status, detail=detail) from error
    except (httpx.HTTPError, ValidationError, ValueError) as error:
        raise HTTPException(status_code=503, detail=_PERSISTENCE_ERROR) from error


def _memory_view(session: SpeakingSession) -> SpeakingSession:
    # Mirror ON DELETE SET NULL without changing the retained language snapshot.
    result = session.model_copy(deep=True)
    for item in result.items:
        source = store.corpus_items.get(str(item.corpus_item_id))
        if source is None or source.user_id != session.user_id:
            item.corpus_item_id = None
    return result


def create_speaking_session(user_id: str, payload: SpeakingSessionCreate) -> SpeakingSession:
    logic = next((item for item in _LOGIC_TEMPLATES if item.id == payload.logic_template_id), None)
    if repository := _repository():
        return _call(repository.create, user_id, payload, logic)

    # This adapter is only for unconfigured inline development and deterministic tests.
    # The durable adapter repeats validation and takes snapshots within one transaction.
    with _MEMORY_LOCK:
        key = (user_id, str(payload.client_id))
        request = payload.model_dump(mode="json")
        previous = store.speaking_session_submissions.get(key)
        if previous is not None and previous[1] in store.speaking_sessions:
            if previous[0] != request:
                raise HTTPException(status_code=409, detail=_RPC_ERRORS["PT409"][1])
            return _memory_view(store.speaking_sessions[previous[1]])

        selected = [store.corpus_items.get(str(item_id)) for item_id in payload.corpus_item_ids]
        if any(item is None or item.user_id != user_id for item in selected):
            raise HTTPException(status_code=404, detail=_RPC_ERRORS["PT404"][1])
        structures = sum(item.kind == "structure" for item in selected)
        if structures > 3 or len(selected) - structures > 5:
            raise HTTPException(status_code=422, detail=_RPC_ERRORS["PT422"][1])
        session = SpeakingSession(
            id=uuid4(), user_id=user_id, client_id=payload.client_id,
            scenario_type=payload.scenario_type, goal=payload.goal,
            difficulty=payload.difficulty, feedback_level=payload.feedback_level,
            logic_template=logic.model_copy(deep=True) if logic else None,
            created_at=datetime.now(timezone.utc),
            items=[SpeakingSessionItem(
                id=uuid4(), corpus_item_id=item.id, ordinal=index, kind=item.kind,
                text=item.text, meaning=item.meaning, tags=list(item.tags), slots=dict(item.slots),
                source_title=item.source_locator.source_title,
            ) for index, item in enumerate(selected)],
        )
        store.speaking_sessions[str(session.id)] = session
        store.speaking_session_submissions[key] = (request, str(session.id))
        return session.model_copy(deep=True)


def get_speaking_session(user_id: str, session_id: str) -> SpeakingSession | None:
    if repository := _repository():
        return _call(repository.get, user_id, session_id)
    with _MEMORY_LOCK:
        session = store.speaking_sessions.get(session_id)
        return _memory_view(session) if session is not None and session.user_id == user_id else None


def submit_turn(user_id: str, session_id: str, payload: SpeakingTurnCreate) -> SpeakingTurnResponse | None:
    if repository := _repository():
        if _call(repository.get, user_id, session_id) is None:
            return None
        raise HTTPException(status_code=501, detail="Role-play is not available yet. Your loadout has been saved.")

    # Preserve the original inline smoke fixture; production never emits fake turns.
    with _MEMORY_LOCK:
        session = store.speaking_sessions.get(session_id)
        if session is None or session.user_id != user_id:
            return None
        session.turn_count += 1
        return SpeakingTurnResponse(
            session_id=session_id,
            ai_message="That gives us a useful starting point. Can you frame the trade-off more explicitly?",
            feedback="Good momentum. Try using one equipped structure to make the reasoning easier to follow.",
            stage_advance=session.turn_count % 2 == 0,
        )
