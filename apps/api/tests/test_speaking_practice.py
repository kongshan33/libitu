"""Linked practice preserves language, learner choice and creation recovery."""
import asyncio
import json
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.corpus import CorpusItemUpdate
from app.schemas.speaking import SpeakingSessionCreate
from app.schemas.speaking_plan import PracticePlanCreate
from app.services import corpus_service, speaking_planning, speaking_service, store
from test_speaking_planning import (  # noqa: F401
    OWNER, client, create_plan, planning_state, proposals, model_output, saved, session_request,
)


def parent_session():
    plan = create_plan()
    response = client.post("/api/speaking/sessions", json={
        **session_request(plan), "support_level": "model_frame",
    })
    assert response.status_code == 201
    parent = store.speaking_sessions[response.json()["id"]]
    parent.status = "completed"
    return parent


def variant_proposals(context):
    result = proposals(context)
    parent = context["practice"]["scenario"]
    for index, candidate in enumerate(result["candidates"]):
        candidate["setting"] = f"Discuss a revised budget for team {index} in the same project."
        candidate["goal"] = f"Agree on the budget review for team {index}."
        if context["practice"]["variation"] == "role_swap":
            candidate.update(user_role=parent["ai_role"], ai_role=parent["user_role"])
        else:
            candidate.update(user_role=parent["user_role"], ai_role=parent["ai_role"])
    return result


def practice_plan(parent, monkeypatch, variation="details"):
    async def provider(settings, prompt, context, **kwargs):
        assert "Do not return changes" in prompt
        return json.dumps(variant_proposals(context)), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", provider)
    return asyncio.run(speaking_planning.create_practice_plan(
        OWNER, str(parent.id), PracticePlanCreate(variation=variation)))


@pytest.mark.parametrize("variation", ["details", "role_swap"])
def test_practice_saves_truthful_changes_and_freezes_parent_item_mapping(monkeypatch, variation):
    parent = parent_session()
    plan = practice_plan(parent, monkeypatch, variation)
    assert plan.practice_source.parent_session_id == parent.id
    assert plan.practice_source.root_session_id == parent.id
    assert len(plan.practice_source.parent_snapshot_hash) == 64
    candidate = plan.candidates[0]
    for change in candidate.changes:
        assert change.before == getattr(parent.mission_plan, change.field)
        assert change.after == getattr(candidate, change.field)
    assert [target.role for target in candidate.targets] == [target.role for target in parent.mission_plan.targets]
    body = {**session_request(plan.model_dump(mode="json")), "support_level": "label_only"}
    child = speaking_service.create_speaking_session(OWNER, SpeakingSessionCreate.model_validate(body))
    assert child.practice.parent_session_id == parent.id
    assert child.practice.changes == candidate.changes
    assert child.support_level == "label_only" and child.evidence_contract_version == "speaking-evidence-v3"
    assert child.items[0].source_corpus_item_id == parent.items[0].source_corpus_item_id
    assert child.items[0].id != parent.items[0].id
    assert child.mission_plan.targets[0].parent_session_item_id == parent.items[0].id
    assert child.mission_plan.targets[0].session_item_id == child.items[0].id


def test_practice_requires_explicit_support_and_never_reuses_parent_support(monkeypatch):
    parent = parent_session()
    plan = practice_plan(parent, monkeypatch)
    before = set(store.speaking_sessions)
    with pytest.raises(HTTPException) as error:
        speaking_service.create_speaking_session(OWNER, SpeakingSessionCreate.model_validate(
            session_request(plan.model_dump(mode="json"))))
    assert error.value.status_code == 422
    assert set(store.speaking_sessions) == before


@pytest.mark.parametrize("change", ["kind", "text", "meaning", "slots", "deleted"])
def test_practice_rejects_changed_language_before_spending_a_model_request(monkeypatch, change):
    parent = parent_session()
    item_id = str(parent.items[0].corpus_item_id)
    if change == "deleted":
        corpus_service.delete_corpus_item(OWNER, item_id)
    elif change == "kind":
        store.corpus_items[item_id].kind = "idiom"
    else:
        value = {"new": "slot"} if change == "slots" else "Changed language"
        corpus_service.update_corpus_item(OWNER, item_id, CorpusItemUpdate(**{change: value}))
    async def forbidden(*args, **kwargs):
        raise AssertionError("No paid generation for changed parent language")
    monkeypatch.setattr(speaking_planning, "request_analysis_json", forbidden)
    with pytest.raises(HTTPException) as error:
        asyncio.run(speaking_planning.create_practice_plan(OWNER, str(parent.id), PracticePlanCreate(variation="details")))
    assert error.value.status_code == 409
    assert "changed or is unavailable" in error.value.detail


def test_practice_allows_new_metadata_without_rewriting_parent_language(monkeypatch):
    parent = parent_session()
    item_id = str(parent.items[0].corpus_item_id)
    corpus_service.update_corpus_item(OWNER, item_id, CorpusItemUpdate(tags=["new"], usage_context="Updated note"))
    plan = practice_plan(parent, monkeypatch)
    assert plan.practice_source.parent_session_id == parent.id
    assert store.speaking_plans[str(plan.id)][1][0]["tags"] == ["new"]
    assert parent.items[0].tags != ["new"]


@pytest.mark.parametrize("state", ["foreign", "missing", "active", "legacy", "equivalent_roles"])
def test_invalid_practice_parent_is_rejected_before_generation(monkeypatch, state):
    parent = parent_session()
    owner = OWNER
    if state == "foreign":
        owner = "different-owner"
    elif state == "missing":
        store.speaking_sessions.pop(str(parent.id))
    elif state == "active":
        parent.status = "active"
    elif state == "legacy":
        parent.mission_plan = None
    else:
        parent.mission_plan.ai_role = parent.mission_plan.user_role.upper() + "."
    async def forbidden(*args, **kwargs):
        raise AssertionError("No generation for an ineligible parent")
    monkeypatch.setattr(speaking_planning, "request_analysis_json", forbidden)
    with pytest.raises(HTTPException) as error:
        asyncio.run(speaking_planning.create_practice_plan(owner, str(parent.id), PracticePlanCreate(variation="role_swap")))
    assert error.value.status_code == (404 if state in {"foreign", "missing"} else 422 if state == "equivalent_roles" else 409)


@pytest.mark.parametrize("variation,invalid", [
    ("details", "unchanged"), ("details", "role"), ("role_swap", "role"),
])
def test_invalid_variation_uses_one_bounded_repair(monkeypatch, variation, invalid):
    parent = parent_session()
    calls = []
    async def provider(settings, prompt, context, **kwargs):
        calls.append(kwargs["timeout_seconds"])
        result = variant_proposals(context)
        if len(calls) == 1:
            if invalid == "unchanged":
                result["candidates"][0].update(
                    setting=parent.mission_plan.setting.upper() + ".", goal=parent.mission_plan.goal.upper() + ".")
            else:
                result["candidates"][0]["user_role"] = "Different role"
        else:
            assert "plan_invalid_variation" in prompt
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", provider)
    plan = asyncio.run(speaking_planning.create_practice_plan(
        OWNER, str(parent.id), PracticePlanCreate(variation=variation)))
    assert len(calls) == 2 and 0 < calls[1] <= calls[0] <= 90
    assert plan.practice_source.variation == variation


def test_failed_variation_never_saves_or_fabricates_changes(monkeypatch):
    parent = parent_session()
    initial = set(store.speaking_plans)
    calls = []
    async def provider(settings, prompt, context, **kwargs):
        calls.append(1)
        result = variant_proposals(context)
        result["candidates"][0]["user_role"] = "Wrong role"
        return model_output(result, context), {}
    monkeypatch.setattr(speaking_planning, "request_analysis_json", provider)
    with pytest.raises(HTTPException) as error:
        asyncio.run(speaking_planning.create_practice_plan(
            OWNER, str(parent.id), PracticePlanCreate(variation="details")))
    assert error.value.status_code == 503
    assert error.value.headers["X-Speaking-Plan-Error"] == "plan_invalid_variation"
    assert len(calls) == 2 and set(store.speaking_plans) == initial


def test_committed_practice_recovers_after_parent_plan_and_corpus_deletion(monkeypatch):
    parent = parent_session()
    plan = practice_plan(parent, monkeypatch)
    payload = SpeakingSessionCreate.model_validate({
        **session_request(plan.model_dump(mode="json")), "support_level": "no_hint",
    })
    child = speaking_service.create_speaking_session(OWNER, payload)
    store.speaking_sessions.pop(str(parent.id))
    store.speaking_plans.pop(str(plan.id))
    corpus_service.delete_corpus_item(OWNER, str(parent.items[0].corpus_item_id))
    restored = speaking_service.create_speaking_session(OWNER, payload)
    assert restored.id == child.id and restored.practice.parent_session_id is None
    assert restored.items[0].corpus_item_id is None
    assert restored.items[0].source_corpus_item_id == child.items[0].source_corpus_item_id
    assert restored.mission_plan == child.mission_plan


def test_later_linked_round_keeps_the_original_root_and_immediate_parent_mapping(monkeypatch):
    parent = parent_session()
    plan = practice_plan(parent, monkeypatch)
    child = speaking_service.create_speaking_session(OWNER, SpeakingSessionCreate.model_validate({
        **session_request(plan.model_dump(mode="json")), "support_level": "label_only",
    }))
    store.speaking_sessions[str(child.id)].status = "completed"
    next_plan = practice_plan(store.speaking_sessions[str(child.id)], monkeypatch, "role_swap")
    assert next_plan.practice_source.parent_session_id == child.id
    assert next_plan.practice_source.root_session_id == parent.id
    next_session = speaking_service.create_speaking_session(OWNER, SpeakingSessionCreate.model_validate({
        **session_request(next_plan.model_dump(mode="json")), "support_level": "no_hint",
    }))
    assert next_session.practice.root_session_id == parent.id
    assert next_session.mission_plan.targets[0].parent_session_item_id == child.items[0].id


def test_parent_deleted_after_planning_aborts_uncommitted_child_creation(monkeypatch):
    parent = parent_session()
    plan = practice_plan(parent, monkeypatch)
    store.speaking_sessions.pop(str(parent.id))
    payload = SpeakingSessionCreate.model_validate({
        **session_request(plan.model_dump(mode="json")), "support_level": "no_hint",
    })
    with pytest.raises(HTTPException) as error:
        speaking_service.create_speaking_session(OWNER, payload)
    assert error.value.status_code == 404
    assert (OWNER, str(payload.client_id)) not in store.speaking_session_submissions


def test_old_supported_submission_recovery_does_not_stamp_new_evidence_contract():
    body = {**session_request(create_plan()), "support_level": "model_frame"}
    original = speaking_service.create_speaking_session(OWNER, SpeakingSessionCreate.model_validate(body))
    old = store.speaking_sessions[str(original.id)]
    old.evidence_contract_version = None
    old.items[0].source_corpus_item_id = None
    restored = speaking_service.create_speaking_session(OWNER, SpeakingSessionCreate.model_validate(body))
    assert restored.evidence_contract_version is None and restored.items[0].source_corpus_item_id is None


@pytest.mark.parametrize("body", [{"variation": "same"}, {"variation": "details", "parent_session_id": str(uuid4())}, {}])
def test_practice_request_cannot_supply_parent_content_or_unknown_variation(body):
    with pytest.raises(ValidationError):
        PracticePlanCreate.model_validate(body)
