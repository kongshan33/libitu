from pydantic import BaseModel, Field


class SpeakingSessionCreate(BaseModel):
    scenario_type: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    corpus_item_ids: list[str] = []


class SpeakingSession(SpeakingSessionCreate):
    id: str
    user_id: str
    turn_count: int = 0


class SpeakingTurnCreate(BaseModel):
    user_message: str = Field(min_length=1)


class SpeakingTurnResponse(BaseModel):
    session_id: str
    ai_message: str
    feedback: str
    stage_advance: bool = False
