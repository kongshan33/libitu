"""Frozen pre-snapshot status read for the opt-in benchmark only."""
from datetime import datetime, timezone
from app.integrations.practice_analysis_repository import PracticeAnalysisRepository
from app.schemas.practice_analysis import AnalysisView, WordCheck, GATED_ANALYSIS_VERSION
from app.schemas.signal_prosody import SignalPair, SignalProsody
from app.services.acoustics.word_check import analysis_scope
from app.services.practice_analysis_service import attempt_owned, reference_for, layer_availability

def read(repo: PracticeAnalysisRepository, owner: str, attempt: str) -> AnalysisView | None:
    attempt_owned(repo, owner, attempt)
    row = repo.get(owner, attempt)
    return view(repo, owner, row) if row else None

def view(repo: PracticeAnalysisRepository, owner: str, row: dict) -> AnalysisView:
    attempt = attempt_owned(repo, owner, row["id"])
    result = row.get("result")
    reference = reference_for(attempt, row.get('reference_id')) if row['state'] == 'queued' else None
    waiting = reference and reference['state'] in ('awaiting_upload', 'queued', 'processing') \
        and (row['analysis_version'] != GATED_ANALYSIS_VERSION or row.get('phase') == 'waiting_reference')
    if result and row.get("reference_id") and reference_for(attempt, row["reference_id"]) is None:
        result = {**result, "reference": None, "assessment": None, "comparison": "unavailable", "reason": "reference_unavailable"}
    check = WordCheck.model_validate(row['word_check']) if row.get('word_check') else None
    scope = analysis_scope(check) if check else None
    coarse = None
    if scope == "all_layers" and row.get("coarse_checkpoint") and row['state'] != 'deleted':
        coarse = SignalPair(learner=SignalProsody.model_validate(row['coarse_checkpoint']))
        bound = reference_for(attempt, row.get('reference_id'))
        if bound and bound.get('audio_ready') and bound.get('snapshot', {}).get('engine') == row['snapshot'].get('engine'):
            sentence = next((r for r in bound.get('results', []) if r['sentence_id'] == attempt['sentence_id']), None)
            candidate = sentence.get('coarse') if sentence else None
            if candidate and candidate.get('version') == coarse.learner.version \
                    and candidate.get('feature_version') == coarse.learner.feature_version \
                    and candidate.get('aggregation_version') == coarse.learner.aggregation_version:
                coarse.reference = SignalProsody.model_validate(candidate)
    return AnalysisView(id=row["id"], sentence_id=attempt["sentence_id"], state=row["state"],
        analysis_version=row["analysis_version"], result=result, error_code='reference_pending' if waiting else row.get("error_code"), created_at=row["created_at"],
        retryable=row["state"] in ("failed", "cancelled") and not row.get("input_cleaned_at")
        and datetime.fromisoformat(row["input_expires_at"]) > datetime.now(timezone.utc),
        phase=row.get('phase'), word_check=check, analysis_scope=scope,
        layers=layer_availability(row, result, check) if row['analysis_version'] == GATED_ANALYSIS_VERSION else None,
        recognition_feedback=attempt.get('recognition_feedback'), coarse=coarse)
