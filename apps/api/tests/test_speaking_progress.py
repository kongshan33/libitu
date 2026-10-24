from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations import speaking_progress_repository as repository
from app.integrations.speaking_feedback_repository import InlineFeedbackStore
from app.integrations.speaking_runtime_repository import InlineRuntimeStore
from app.main import app
from app.schemas.speaking import EVIDENCE_CONTRACT_VERSION, SpeakingPractice
from app.schemas.speaking_feedback import FeedbackItem, FeedbackResult, FeedbackStatistics, SpeakingFeedback
from app.schemas.speaking_progress import SupportRecommendationRequest
from app.services import speaking_progress as progress, store
from test_speaking_opportunities import add_plan
from test_speaking_teaching import mission


def history_report(corpus_id, day=1, scene="Meeting A", root=None):
    sid, iid = str(uuid4()), str(uuid4())
    return {
        "id": str(uuid4()), "session_id": sid, "status": "ready",
        "analysis_version": "speaking-feedback-v3", "rubric_version": "speaking-rubric-v2",
        "evidence_contract_version": EVIDENCE_CONTRACT_VERSION,
        "practiced_at": f"2026-10-{day:02d}T08:00:00+00:00", "root_session_id": root or sid,
        "scene": {"setting": scene, "goal": "Choose a date", "user_role": "Lead", "ai_role": "Colleague"},
        "items": [{
            "item": {"id": iid, "source_corpus_item_id": corpus_id, "kind": "chunk",
                     "text": "to be fair", "meaning": "consider another view", "slots": {}},
            "target_role": "primary", "skipped": False,
            "result": {"session_item_id": iid, "status": "appropriate", "role": "primary",
                       "opportunity_status": "used", "excluded_reason": None, "independent_uses": 1,
                       "qualifying_independent_evidence": [{"message_id": "user", "transcript_revision": 1,
                           "quote": "to be fair", "start": 0, "end": 10}]},
            "messages": [{"id": "user", "role": "user", "status": "final", "revision": 1,
                          "finalized_at": f"2026-10-{day:02d}T08:00:00+00:00",
                          "ordinal": 1, "text": "to be fair, testing takes time."}],
        }],
    }


@pytest.fixture
def history(monkeypatch):
    corpus_id = str(uuid4())
    reports = [history_report(corpus_id, 1), history_report(corpus_id, 2),
               history_report(corpus_id, 2, "Meeting B")]
    content = deepcopy(reports[0]["items"][0]["item"])
    monkeypatch.setattr(progress, "_repository", lambda: None)
    monkeypatch.setattr(progress, "get_corpus_item", lambda owner, cid:
                        SimpleNamespace(model_dump=lambda **kwargs: content) if cid == corpus_id else None)
    monkeypatch.setattr(progress, "read_support_history", lambda owner, ids:
                        {"reports": reports, "has_more": False})
    request = SupportRecommendationRequest(targets=[{"corpus_item_id": corpus_id, "role": "primary"}],
                                           current_level="model_frame")
    return corpus_id, reports, content, request


def test_repeated_history_suggests_only_one_level_without_mutation(history):
    _, reports, _, request = history
    before = deepcopy(reports)
    result = progress.recommend_support("owner", request)
    assert result.status == "suggest_reduce" and result.suggested_level == "model_label"
    assert result.targets[0].qualifying_missions == 3
    assert result.targets[0].practice_days == 2 and result.targets[0].scene_roots == 2
    assert reports == before and request.current_level == "model_frame"


@pytest.mark.parametrize("fault", [
    "partial", "old_report", "old_contract", "skipped", "excluded", "optional", "not_appropriate",
    "no_independent", "mixed_evidence_only", "invalid_quote", "wrong_revision", "assistant",
    "interrupted", "later_revision", "wrong_item", "missing_identity", "changed_language",
])
def test_unreliable_history_cannot_recommend_reduction(history, fault):
    _, reports, _, request = history
    row, target = reports[-1], reports[-1]["items"][0]
    result = target["result"]
    if fault == "partial":
        row["status"] = "partial"
    elif fault == "old_report":
        row["analysis_version"] = "speaking-feedback-v2"
    elif fault == "old_contract":
        row["evidence_contract_version"] = None
    elif fault == "skipped":
        target["skipped"] = True
    elif fault == "excluded":
        result["excluded_reason"] = "No opportunity."
    elif fault == "optional":
        target["target_role"] = "opportunity"
    elif fault == "not_appropriate":
        result["status"] = "uncertain"
    elif fault == "no_independent":
        result["independent_uses"] = 0
    elif fault == "mixed_evidence_only":
        result["evidence"] = result.pop("qualifying_independent_evidence")
    elif fault == "invalid_quote":
        result["qualifying_independent_evidence"][0]["quote"] = "invented"
    elif fault == "wrong_revision":
        result["qualifying_independent_evidence"][0]["transcript_revision"] = 3
    elif fault == "assistant":
        target["messages"][0]["role"] = "assistant"
    elif fault == "interrupted":
        target["messages"][0]["status"] = "interrupted"
    elif fault == "later_revision":
        target["messages"].append({**target["messages"][0], "revision": 2, "text": "other words"})
    elif fault == "wrong_item":
        result["session_item_id"] = str(uuid4())
    elif fault == "missing_identity":
        target["item"]["source_corpus_item_id"] = None
    else:
        target["item"]["meaning"] = "different language"
    response = progress.recommend_support("owner", request)
    assert response.status == "insufficient_history" and response.suggested_level is None
    assert response.targets[0].qualifying_missions == 2


def test_content_edits_reset_eligibility_but_metadata_edits_do_not(history):
    _, _, content, request = history
    content.update(tags=["new function"], register="formal")
    assert progress.recommend_support("owner", request).status == "suggest_reduce"
    content["text"] = "in fairness"
    assert progress.recommend_support("owner", request).targets[0].qualifying_missions == 0


@pytest.mark.parametrize("mode", ["repeated_session", "same_day", "same_root", "same_scene"])
def test_repetition_cannot_manufacture_varied_history(history, mode):
    _, reports, _, request = history
    if mode == "repeated_session":
        reports[-1]["session_id"] = reports[0]["session_id"]
    elif mode == "same_day":
        for row in reports:
            row["items"][0]["messages"][0]["finalized_at"] = "2026-10-01T08:00:00+00:00"
    elif mode == "same_root":
        for row in reports:
            row["root_session_id"] = reports[0]["root_session_id"]
    else:
        reports[-1]["scene"] = deepcopy(reports[0]["scene"])
    assert progress.recommend_support("owner", request).status == "insufficient_history"


def test_no_hint_and_legacy_settings_are_never_auto_advanced(history):
    _, _, _, request = history
    for level in ("no_hint", None):
        response = progress.recommend_support("owner", request.model_copy(update={"current_level": level}))
        assert response.status == "keep_current" and response.suggested_level is None


def test_utc_practice_dates_and_missing_dates_are_conservative(history):
    _, reports, _, request = history
    reports[1]["items"][0]["messages"][0]["finalized_at"] = "2026-10-02T00:01:00+08:00"
    reports[2]["items"][0]["messages"][0]["finalized_at"] = "2026-10-02T00:02:00+08:00"
    assert progress.recommend_support("owner", request).targets[0].practice_days == 1
    reports[2]["items"][0]["messages"][0]["finalized_at"] = "2026-10-02T08:00:00"  # no timezone
    assert progress.recommend_support("owner", request).targets[0].qualifying_missions == 2


def test_every_primary_must_qualify_optional_targets_do_not_gate(history, monkeypatch):
    cid, _, content, request = history
    second_id = str(uuid4())
    monkeypatch.setattr(progress, "get_corpus_item", lambda *args: SimpleNamespace(model_dump=lambda **kw: content))
    for role, expected in (("primary", "insufficient_history"), ("opportunity", "suggest_reduce")):
        request = SupportRecommendationRequest(targets=[
            {"corpus_item_id": cid, "role": "primary"}, {"corpus_item_id": second_id, "role": role}],
            current_level="label_only")
        response = progress.recommend_support("owner", request)
        assert response.status == expected
        assert response.targets[-1].qualifying_missions == 0


def test_history_requests_enforce_identity_selection_and_do_not_create_jobs(history):
    cid, _, _, _ = history
    client = TestClient(app)
    payload = {"targets": [{"corpus_item_id": cid, "role": "primary"}], "current_level": "model_label"}
    app.dependency_overrides.clear()
    assert client.post("/api/speaking/support-recommendations", json=payload).status_code == 401
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="progress-owner")
    try:
        assert client.post("/api/speaking/support-recommendations", json=payload).status_code == 200
        assert client.post("/api/speaking/support-recommendations",
                           json={**payload, "targets": payload["targets"] * 2}).status_code == 422
        assert client.post("/api/speaking/support-recommendations", json={
            **payload, "targets": [{"corpus_item_id": str(uuid4()), "role": "primary"}]}).status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_projection_is_bounded_owner_scoped_read_only_and_excludes_unrelated_source(monkeypatch):
    adapter = InlineFeedbackStore(InlineRuntimeStore())
    monkeypatch.setattr(repository, "get_feedback_store", lambda: adapter)
    item_id = str(uuid4())
    owned_ids = []
    for index in range(102):
        session = add_plan(mission(("chunk", "to be fair")))
        session.user_id = "progress-owner" if index < 101 else "another-owner"
        session.status = "completed"
        session.items[0].source_corpus_item_id = UUID(item_id)
        session.created_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
        sid = str(session.id)
        owned_ids.append(sid)
        store.speaking_sessions[sid] = session
        adapter._jobs[sid] = {
            "id": str(uuid4()), "user_id": session.user_id, "session_id": sid, "status": "ready",
            "created_at": f"2026-10-02T08:{index // 60:02d}:{index % 60:02d}+00:00",
            "source": {"session": session.model_dump(mode="json"),
                       "messages": [{"id": "secret-message", "text": "unrelated private content"}],
                       "controller": {"private": "do not expose"}},
            "result": None,
        }
    try:
        before = deepcopy(adapter._jobs)
        value = repository.read_support_history("progress-owner", [item_id])
        assert value["has_more"] and len(value["reports"]) == 100
        assert "private" not in str(value) and "secret-message" not in str(value)
        assert all("practiced_at" not in row for row in value["reports"])
        assert adapter._jobs == before
        store.speaking_sessions.pop(owned_ids[0])
        assert repository.read_support_history("progress-owner", [item_id])["has_more"] is False
    finally:
        for sid in owned_ids:
            store.speaking_sessions.pop(sid, None)


def test_creation_dates_and_report_retry_dates_do_not_prove_practice_days(history):
    _, reports, _, request = history
    for index, row in enumerate(reports):
        row["practiced_at"] = f"2026-10-{index + 1:02d}T08:00:00Z"
        row["items"][0]["messages"][0]["finalized_at"] = "2026-10-20T08:00:00Z"
    response = progress.recommend_support("owner", request)
    assert response.targets[0].practice_days == 1 and response.status == "insufficient_history"
    for row in reports:
        row["items"][0]["messages"][0].pop("finalized_at")
    assert progress.recommend_support("owner", request).targets[0].qualifying_missions == 0


@pytest.fixture
def comparison(monkeypatch):
    parent = add_plan(mission(("chunk", "to be fair")))
    parent.status, parent.support_level = "completed", "model_frame"
    child = parent.model_copy(deep=True)
    child.id, child.items[0].id = uuid4(), uuid4()
    child.support_level = "label_only"
    child.practice = SpeakingPractice(parent_session_id=parent.id, root_session_id=parent.id,
                                      variation="details", changes=[])
    child.mission_plan.targets[0].parent_session_item_id = parent.items[0].id
    child.mission_plan.targets[0].session_item_id = child.items[0].id
    child.mission_plan.setting = "A different deadline meeting"
    sessions = {str(row.id): row for row in (parent, child)}
    reports = {}
    for session in (parent, child):
        reports[str(session.id)] = SpeakingFeedback(
            id=str(uuid4()), session_id=str(session.id), status="ready", input_hash="a" * 64,
            created_at="2026-10-01T00:00:00Z", updated_at="2026-10-01T00:00:00Z",
            session=session, messages=[], effective_support_level="no_hint",
            result=FeedbackResult(dimensions=[], statistics=FeedbackStatistics(), item_results=[
                FeedbackItem(session_item_id=str(session.items[0].id), kind="chunk", text="to be fair",
                             status="appropriate", role="primary", independent_uses=1, reason="Evidence")]),
        )
    jobs = {sid: {"status": "ready", "rubric_version": "speaking-rubric-v2",
                  "analysis_version": "speaking-feedback-v3", "report": report}
            for sid, report in reports.items()}
    monkeypatch.setattr(progress, "require_session", lambda owner, sid: sessions[sid])
    monkeypatch.setattr(progress, "get_speaking_session", lambda owner, sid: sessions.get(sid))
    monkeypatch.setattr(progress, "get_feedback_store", lambda: SimpleNamespace(read=lambda owner, sid: jobs.get(sid)))
    monkeypatch.setattr(progress, "public_feedback", lambda job: job["report"])
    return parent, child, sessions, reports, jobs


def test_comparison_uses_existing_reports_and_frozen_final_support(comparison):
    _, child, _, _, jobs = comparison
    before = deepcopy(jobs)
    result = progress.compare_practice("owner", str(child.id))
    assert result.status == "ready" and len(result.items) == 1
    assert result.parent_support_level == "no_hint" and result.child_support_level == "no_hint"
    assert jobs == before


@pytest.mark.parametrize("fault,status", [
    ("missing_parent", "unavailable"), ("missing_report", "pending"), ("processing", "pending"),
    ("partial", "unavailable"), ("old_rubric", "incompatible"), ("changed_language", "incompatible"),
    ("wrong_source", "incompatible"), ("wrong_parent_item", "incompatible"), ("wrong_role", "incompatible"),
])
def test_comparison_does_not_invent_before_after_values(comparison, fault, status):
    parent, child, sessions, reports, jobs = comparison
    if fault == "missing_parent":
        sessions.pop(str(parent.id))
    elif fault == "missing_report":
        jobs.pop(str(parent.id))
    elif fault in ("partial", "processing"):
        jobs[str(parent.id)]["status"] = fault
    elif fault == "old_rubric":
        jobs[str(parent.id)]["rubric_version"] = "speaking-rubric-v1"
        jobs[str(parent.id)]["analysis_version"] = "speaking-feedback-v1"
    elif fault == "changed_language":
        reports[str(child.id)].session.items[0].meaning = "different"
    elif fault == "wrong_source":
        reports[str(child.id)].session.items[0].corpus_item_id = uuid4()
    elif fault == "wrong_parent_item":
        reports[str(child.id)].session.mission_plan.targets[0].parent_session_item_id = uuid4()
    else:
        reports[str(child.id)].session.mission_plan.targets[0].role = "opportunity"
    result = progress.compare_practice("owner", str(child.id))
    assert result.status == status and not result.items
