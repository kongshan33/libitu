from pydantic import BaseModel, ConfigDict, model_validator
from app.schemas.practice import AttemptCreate
from app.schemas.practice_analysis import AnalysisCreate


class PracticeSubmission(BaseModel):
    model_config = ConfigDict(extra='forbid')
    attempt: AttemptCreate
    analysis: AnalysisCreate

    @model_validator(mode='after')
    def same_audio_for_independent_purposes(self):
        retention = self.attempt.recording
        if retention and (retention.sha256, retention.size, retention.mime_type) != (
                self.analysis.sha256, self.analysis.size, self.analysis.mime_type):
            raise ValueError('Analysis and retained recording must describe the same audio')
        return self
