"""Application use cases; durable fencing precedes process-local cleanup."""
import asyncio
import logging

from app.schemas.speaking_runtime import SpeakingWorkspace
from app.services import speaking_runtime_state
from app.services.speaking_runtime import stop_local
from app.services.speaking_feedback_service import request_feedback

log = logging.getLogger(__name__)


async def _stop_after_commit(session_id: str) -> None:
    try:
        await stop_local(session_id)
    except Exception:
        # Persisted runtime fencing protects other processes and late writes.
        log.warning("speaking_local_cleanup_deferred")


async def end_speaking_session(owner: str, session_id: str) -> SpeakingWorkspace:
    result = await asyncio.to_thread(speaking_runtime_state.end_session, owner, session_id)
    await _stop_after_commit(session_id)
    try:
        await asyncio.to_thread(request_feedback, owner, session_id)
    except Exception:
        # The existing worker reconciles completed sessions without feedback.
        # Do not log provider text, transcript or credentials.
        log.warning("speaking_feedback_enqueue_deferred")
    return result


async def delete_speaking_session(owner: str, session_id: str) -> None:
    await asyncio.to_thread(speaking_runtime_state.delete_session, owner, session_id)
    await _stop_after_commit(session_id)
