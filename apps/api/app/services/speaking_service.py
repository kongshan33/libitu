from uuid import uuid4

from app.schemas.speaking import SpeakingSession, SpeakingSessionCreate, SpeakingTurnCreate, SpeakingTurnResponse
from app.services import store


def create_speaking_session(user_id: str, payload: SpeakingSessionCreate) -> SpeakingSession:
    session = SpeakingSession(id=str(uuid4()), user_id=user_id, **payload.model_dump())
    store.speaking_sessions[session.id] = session
    return session


def submit_turn(user_id: str, session_id: str, payload: SpeakingTurnCreate) -> SpeakingTurnResponse | None:
    session = store.speaking_sessions.get(session_id)
    if session is None or session.user_id != user_id:
        return None

    session.turn_count += 1
    store.speaking_sessions[session_id] = session
    return SpeakingTurnResponse(
        session_id=session_id,
        ai_message="That gives us a useful starting point. Can you frame the trade-off more explicitly?",
        feedback="Good momentum. Try using one equipped structure to make the reasoning easier to follow.",
        stage_advance=session.turn_count % 2 == 0,
    )
