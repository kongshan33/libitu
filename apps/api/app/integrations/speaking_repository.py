"""Owner-scoped loadout snapshots, created atomically by a database RPC."""

from app.integrations.supabase_repository import SupabaseRepository, get_supabase_repository
from app.schemas.speaking import EVIDENCE_CONTRACT_VERSION, LogicTemplate, SpeakingSession, SpeakingSessionCreate
from app.schemas.speaking_plan import SpeakingPlan


class SpeakingRepository:
    def __init__(self, database: SupabaseRepository) -> None:
        self.database = database

    def create(
        self, owner: str, payload: SpeakingSessionCreate, logic_template: LogicTemplate | None,
    ) -> SpeakingSession:
        parameters = {
            "p_user_id": owner,
            "p_client_id": str(payload.client_id),
            "p_scenario_type": payload.scenario_type,
            "p_goal": payload.goal,
            "p_difficulty": payload.difficulty,
            "p_feedback_level": payload.feedback_level,
            "p_logic_template": logic_template.model_dump(mode="json") if logic_template else None,
            "p_corpus_item_ids": [str(item_id) for item_id in payload.corpus_item_ids],
        }
        if payload.plan_id is not None:
            parameters.update(p_plan_id=str(payload.plan_id), p_candidate_id=str(payload.candidate_id))
        path = "/rpc/create_planned_speaking_loadout" if payload.plan_id else "/rpc/create_speaking_loadout"
        if payload.support_level is not None or payload.plan_id is not None:
            parameters["p_support_level"] = payload.support_level
            parameters["p_evidence_contract_version"] = (
                EVIDENCE_CONTRACT_VERSION if payload.support_level is not None else None)
            path = "/rpc/create_evidence_speaking_loadout"
        document = self.database._request(
            "POST", path,
            json=parameters,
        ).json()
        return SpeakingSession.model_validate(document)

    def save_plan(self, owner: str, plan: SpeakingPlan, snapshots: list[dict]) -> SpeakingPlan:
        path = "/rpc/save_practice_speaking_plan" if plan.practice_source else "/rpc/save_speaking_plan"
        document = self.database._request("POST", path, json={
            "p_user_id": owner, "p_plan": plan.model_dump(mode="json"), "p_corpus_snapshots": snapshots,
        }).json()
        return SpeakingPlan.model_validate(document)

    def get_plan(self, owner: str, plan_id: str) -> SpeakingPlan | None:
        document = self.database._request("POST", "/rpc/get_speaking_plan", json={
            "p_user_id": owner, "p_plan_id": plan_id,
        }).json()
        return SpeakingPlan.model_validate(document) if document is not None else None

    def get(self, owner: str, session_id: str) -> SpeakingSession | None:
        document = self.database._request("POST", "/rpc/get_speaking_loadout", json={
            "p_user_id": owner, "p_session_id": session_id,
        }).json()
        return SpeakingSession.model_validate(document) if document is not None else None


def get_speaking_repository() -> SpeakingRepository | None:
    database = get_supabase_repository()
    return SpeakingRepository(database) if database is not None else None
