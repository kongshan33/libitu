import copy
import json

import pytest
from pydantic import ValidationError

from app.schemas.speaking_plan import ScenarioProposals, SpeakingPlanCreate
from app.services import speaking_planning as planning
from app.services.speaking_plan_repair import apply_repairs, ordered_output, repair_context


def fixture(count=1, target_count=2):
    snapshots = [{
        "corpus_item_id": f"12345678-abcd-abcd-abcd-{index:012}",
        "kind": "chunk", "text": ["to be fair", "as far as I know", "in my view", "by the way", "for example"][index],
        "register": None, "scenario_tags": [],
    } for index in range(target_count)]
    payload = SpeakingPlanCreate(scenario_type="workplace", candidate_count=count, targets=[
        {"corpus_item_id": item["corpus_item_id"], "role": "primary" if index < 3 else "opportunity"}
        for index, item in enumerate(snapshots)
    ])
    context = {
        "scenario_type": "workplace", "brief": "", "output_schema": planning._generation_schema(payload),
        "targets": [{**item, "role": target.role} for item, target in zip(snapshots, payload.targets)],
    }
    document = {"candidates": [{
        "title": f"Plan discussion {index}", "setting": "Two colleagues discuss delivery",
        "goal": f"Agree on milestone {index}", "user_role": "Project lead", "ai_role": "Delivery manager",
        "register": "professional", "targets": [{
            "corpus_item_id": item["corpus_item_id"], "role": item["role"],
            "communicative_function": "Offer a reasoned perspective", "fit": "high",
            "fit_reason": "The team needs a perspective", "trigger_question": "What is your perspective?",
            "skip_when": "The decision is already settled", "sentence_frame": "{{target}}, [your point].",
        } for item in context["targets"]],
    } for index in range(count)]}
    return payload, snapshots, context, document


def patches_from(reference, context):
    patches = {}
    for task in context["repair_tasks"]:
        value = reference
        for key in task["path"]:
            value = value[key]
        patches[task["id"]] = value
    return json.dumps({"repairs": patches})


def test_one_patch_contains_original_schema_semantic_and_practice_errors():
    payload, snapshots, context, good = fixture()
    practice = {"variation": "details", "scenario": {
        "user_role": "Project lead", "ai_role": "Delivery manager",
        "setting": "The team met last week", "goal": "Decide last week's milestone",
    }}
    context["practice"] = practice
    broken = copy.deepcopy(good)
    broken["candidates"][0]["user_role"] = "An unrelated role"
    broken["candidates"][0]["targets"][0]["skip_when"] = None
    broken["candidates"][0]["targets"][1]["sentence_frame"] = "{{target}}"
    before = copy.deepcopy(broken)
    with pytest.raises(planning._PlanContractError) as raised:
        planning._inspect_output(broken, payload, snapshots, practice)
    assert set(raised.value.codes) == {"invalid_output_schema", "plan_invalid_frame", "plan_invalid_variation"}
    repair = repair_context(broken, context, raised.value.issues)
    assert {tuple(task["path"]) for task in repair["repair_tasks"]} == {
        ("candidates", 0, "user_role"),
        ("candidates", 0, "targets", 0, "skip_when"),
        ("candidates", 0, "targets", 1, "sentence_frame"),
    }
    fixed = apply_repairs(broken, repair, patches_from(good, repair))
    assert broken == before  # Inspection and patch preparation never alter inputs.
    assert fixed == good
    accepted = planning._inspect_output(fixed, payload, snapshots, practice)
    assert accepted.candidates[0].targets[1].sentence_frame == "as far as I know, [your point]."


def test_semantic_error_does_not_hide_original_practice_role_or_detail_errors():
    payload, snapshots, context, document = fixture()
    original = copy.deepcopy(document["candidates"][0])
    practice = {"variation": "details", "scenario": original}
    document["candidates"][0]["ai_role"] = "Different role"
    document["candidates"][0]["targets"][0]["trigger_question"] = "Can you say to be fair?"
    with pytest.raises(planning._PlanContractError) as raised:
        planning._inspect_output(document, payload, snapshots, practice)
    assert {tuple(issue["path"]) for issue in raised.value.issues} == {
        ("candidates", 0, "targets", 0, "trigger_question"),
        ("candidates", 0, "ai_role"), ("candidates", 0, "goal"),
    }


@pytest.mark.parametrize("uuid_form", ["uppercase", "no_hyphens"])
def test_reordered_equivalent_uuids_patch_the_original_affected_target(uuid_form):
    payload, snapshots, context, good = fixture()
    broken = copy.deepcopy(good)
    broken["candidates"][0]["targets"][1]["sentence_frame"] = "{{target}}"
    for target in broken["candidates"][0]["targets"]:
        target["corpus_item_id"] = (target["corpus_item_id"].upper() if uuid_form == "uppercase"
                                    else target["corpus_item_id"].replace("-", ""))
    broken["candidates"][0]["targets"].reverse()
    canonical = ordered_output(json.dumps(broken), context)
    with pytest.raises(planning._PlanContractError) as raised:
        planning._inspect_output(canonical, payload, snapshots)
    repair = repair_context(canonical, context, raised.value.issues)
    assert [task["path"] for task in repair["repair_tasks"]] == [
        ["candidates", 0, "targets", 1, "sentence_frame"],
    ]
    fixed = apply_repairs(canonical, repair, patches_from(good, repair))
    accepted = planning._inspect_output(fixed, payload, snapshots)
    assert [str(target.corpus_item_id) for target in accepted.candidates[0].targets] == [
        item["corpus_item_id"] for item in snapshots
    ]


def test_schema_diagnostics_above_twelve_are_repaired_together():
    payload, snapshots, context, good = fixture(count=2)
    broken = copy.deepcopy(good)
    for candidate in broken["candidates"]:
        for target in candidate["targets"]:
            for field in ("communicative_function", "fit_reason", "trigger_question", "skip_when"):
                target[field] = None
    with pytest.raises(planning._PlanContractError) as raised:
        planning._inspect_output(broken, payload, snapshots)
    repair = repair_context(broken, context, raised.value.issues)
    assert len(repair["repair_tasks"]) == 16
    fixed = apply_repairs(broken, repair, patches_from(good, repair))
    assert len(planning._inspect_output(fixed, payload, snapshots).candidates) == 2


def test_excess_schema_errors_disable_repair_instead_of_silently_truncating():
    payload, snapshots, context, broken = fixture(count=2, target_count=5)
    for candidate in broken["candidates"]:
        candidate["title"] = None
        for target in candidate["targets"]:
            for field in ("communicative_function", "fit", "fit_reason", "trigger_question", "skip_when", "sentence_frame"):
                target[field] = []
    with pytest.raises(ValidationError) as raised:
        ScenarioProposals.model_validate(broken)
    assert raised.value.error_count() > 60
    issues = planning._validation_diagnostics(raised.value)
    assert issues == [{"path": [], "type": "too_many_validation_errors"}]
    assert repair_context(broken, context, issues) is None


def test_unverified_target_identity_does_not_receive_source_specific_field_patches():
    payload, snapshots, context, broken = fixture()
    broken["candidates"][0]["targets"][0]["role"] = "opportunity"
    broken["candidates"][0]["targets"][0]["sentence_frame"] = "{{target}}"
    with pytest.raises(planning._PlanContractError) as raised:
        planning._inspect_output(broken, payload, snapshots)
    assert [issue["path"] for issue in raised.value.issues] == [["candidates", 0, "targets"]]
    repair = repair_context(broken, context, raised.value.issues)
    assert [task["field"] for task in repair["repair_tasks"]] == ["targets"]
