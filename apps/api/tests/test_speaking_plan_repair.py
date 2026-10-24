"""Regression boundaries for single scenes and model field patches."""

import copy
import json

import pytest

from app.services import speaking_planning, store
from test_speaking_planning import (  # noqa: F401
    client, planning_state, proposals, request_body, saved, session_request,
)


@pytest.mark.parametrize("count", [1, 2])
def test_requested_scene_count_reaches_saved_mission_and_preserves_retry(monkeypatch, count):
    calls = []

    async def provider(settings, prompt, context, **kwargs):
        calls.append(context)
        bounds = context["output_schema"]["properties"]["candidates"]
        assert bounds["minItems"] == bounds["maxItems"] == count
        assert kwargs["max_tokens"] == (3500 if count == 1 else 6500)
        return json.dumps(proposals(context)), {}

    monkeypatch.setattr(speaking_planning, "request_analysis_json", provider)
    response = client.post("/api/speaking/plans", json={**request_body(), "candidate_count": count})
    assert response.status_code == 201
    plan = response.json()
    assert len(plan["candidates"]) == count
    payload = session_request(plan)
    mission = client.post("/api/speaking/sessions", json=payload)
    assert mission.status_code == 201
    assert mission.json()["mission_plan"]["candidate_id"] == plan["candidates"][0]["id"]
    assert client.post("/api/speaking/sessions", json=payload).json() == mission.json()
    assert len(calls) == 1


def test_frame_patch_keeps_all_other_scenes_and_fields_exactly(monkeypatch):
    original, contexts = {}, []

    async def provider(settings, prompt, context, **kwargs):
        contexts.append(copy.deepcopy(context))
        if len(contexts) == 1:
            original.update(proposals(context))
            original["candidates"][1]["targets"][1]["sentence_frame"] = "{{target}}"
            return json.dumps(original), {}
        assert [task["path"] for task in context["repair_tasks"]] == [
            ["candidates", 1, "targets", 1, "sentence_frame"]]
        assert [scene["index"] for scene in context["scenes"]] == [1]
        assert "candidates" not in context and kwargs["max_tokens"] == 700
        return json.dumps({"repairs": {"r0": "{{target}}, [my own reason]."}}), {}

    monkeypatch.setattr(speaking_planning, "request_analysis_json", provider)
    response = client.post("/api/speaking/plans", json=request_body([saved(), saved()]))
    assert response.status_code == 201
    actual = response.json()["candidates"]
    original["candidates"][1]["targets"][1]["sentence_frame"] = "to be fair, [my own reason]."
    for before, after in zip(original["candidates"], actual, strict=True):
        for field, value in before.items():
            if field != "targets":
                assert after[field] == value
            else:
                for old_target, new_target in zip(value, after[field], strict=True):
                    assert all(new_target[key] == old for key, old in old_target.items())
    assert len(contexts) == 2


@pytest.mark.parametrize("patch", [
    '{"repairs":{}}',
    '{"repairs":{"r0":"{{target}}, [reason]","r1":"extra"}}',
    '{"repairs":{"r0":"{{target}}, [reason]"},"path":["candidates"]}',
    '{"repairs":{"r0":"first","r0":"{{target}}, [reason]"}}',
    '{"candidates":[]}',
    '{"repairs":{"r0":{"path":["candidates"],"value":[]}}}',
    '[' * 1100 + '0' + ']' * 1100,
])
def test_unrequested_or_malformed_patch_never_saves(monkeypatch, patch):
    calls = []

    async def provider(settings, prompt, context, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            value = proposals(context)
            value["candidates"][0]["targets"][0]["sentence_frame"] = "{{target}}"
            return json.dumps(value), {}
        return patch, {}

    monkeypatch.setattr(speaking_planning, "request_analysis_json", provider)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert len(calls) == 2 and not store.speaking_plans


@pytest.mark.parametrize("raw", ['not json', '[' * 1100 + '0' + ']' * 1100])
def test_unlocatable_output_fails_once_with_selection_kept(monkeypatch, raw):
    calls = []

    async def provider(*args, **kwargs):
        calls.append(1)
        return raw, {}

    monkeypatch.setattr(speaking_planning, "request_analysis_json", provider)
    response = client.post("/api/speaking/plans", json=request_body())
    assert response.status_code == 503
    assert "selection is kept" in response.json()["detail"]
    assert len(calls) == 1 and not store.speaking_plans
