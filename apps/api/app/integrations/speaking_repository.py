"""Owner-scoped loadout snapshots, created atomically by a database RPC."""

from app.integrations.supabase_repository import SupabaseRepository, get_supabase_repository
from app.schemas.speaking import LogicTemplate, SpeakingSession, SpeakingSessionCreate


class SpeakingRepository:
    def __init__(self, database: SupabaseRepository) -> None:
        self.database = database

    def create(
        self, owner: str, payload: SpeakingSessionCreate, logic_template: LogicTemplate | None,
    ) -> SpeakingSession:
        document = self.database._request("POST", "/rpc/create_speaking_loadout", json={
            "p_user_id": owner,
            "p_client_id": str(payload.client_id),
            "p_scenario_type": payload.scenario_type,
            "p_goal": payload.goal,
            "p_difficulty": payload.difficulty,
            "p_feedback_level": payload.feedback_level,
            "p_logic_template": logic_template.model_dump(mode="json") if logic_template else None,
            "p_corpus_item_ids": [str(item_id) for item_id in payload.corpus_item_ids],
        }).json()
        return SpeakingSession.model_validate(document)

    def get(self, owner: str, session_id: str) -> SpeakingSession | None:
        document = self.database._request("POST", "/rpc/get_speaking_loadout", json={
            "p_user_id": owner, "p_session_id": session_id,
        }).json()
        return SpeakingSession.model_validate(document) if document is not None else None


def get_speaking_repository() -> SpeakingRepository | None:
    database = get_supabase_repository()
    return SpeakingRepository(database) if database is not None else None
