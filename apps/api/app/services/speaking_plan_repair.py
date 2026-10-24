"""Construct bounded field patches; model output can never choose patch locations."""

import copy
import json
from uuid import UUID


SCENE_FIELDS = {"title", "setting", "goal", "user_role", "ai_role", "register"}
TARGET_FIELDS = {"communicative_function", "fit", "fit_reason", "trigger_question",
                 "skip_when", "sentence_frame"}


def ordered_output(raw: str, context: dict) -> dict:
    """Canonicalize only complete, uniquely identified target sets before locating errors."""
    document = json.loads(raw)
    if not isinstance(document, dict):
        return document
    expected = {item["corpus_item_id"]: item["role"] for item in context["targets"]}
    for candidate in document.get("candidates", []) if isinstance(document.get("candidates"), list) else []:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("targets"), list):
            continue
        targets = candidate["targets"]
        if not all(isinstance(item, dict) and isinstance(item.get("corpus_item_id"), str) for item in targets):
            continue
        try:
            by_id = {str(UUID(item["corpus_item_id"])): item for item in targets}
        except ValueError:
            continue
        if (len(targets) == len(expected) and set(by_id) == set(expected)
                and all(item.get("role") == expected[item_id] for item_id, item in by_id.items())):
            candidate["targets"] = [by_id[item["corpus_item_id"]] for item in context["targets"]]
    return document


def repair_context(document: dict, context: dict, issues: list[dict]) -> dict | None:
    """Return only affected scenes/tasks. Unlocatable structural failures stop safely."""
    if not isinstance(document, dict) or not isinstance(document.get("candidates"), list):
        return None
    candidates = document["candidates"]
    schema = context["output_schema"]
    candidate_schema = schema["$defs"]["ScenarioProposal"]
    target_schema = schema["$defs"]["SpeakingPlanTarget"]
    paths: list[tuple] = []
    for issue in issues:
        path = tuple(issue["path"])
        if (len(path) < 3 or path[0] != "candidates" or type(path[1]) is not int
                or not 0 <= path[1] < len(candidates) or not isinstance(candidates[path[1]], dict)):
            return None
        if len(path) == 3 and path[2] in SCENE_FIELDS | {"targets"}:
            pass
        elif (len(path) == 5 and path[2] == "targets" and type(path[3]) is int
              and 0 <= path[3] < len(context["targets"]) and path[4] in TARGET_FIELDS):
            targets = candidates[path[1]].get("targets")
            if not isinstance(targets, list) or path[3] >= len(targets) or not isinstance(targets[path[3]], dict):
                return None
        else:
            return None
        if path not in paths:
            paths.append(path)
    # A target-array repair subsumes its child errors; never apply overlapping patches.
    paths = [path for path in paths if not any(path[:len(other)] == other and path != other for other in paths)]
    if not paths or len(paths) > 60:
        return None
    tasks, properties = [], {}
    for index, path in enumerate(paths):
        task_id = f"r{index}"
        value_schema = copy.deepcopy(candidate_schema["properties"][path[2]] if len(path) == 3
                                     else target_schema["properties"][path[4]])
        if path[-1] == "targets":
            value_schema.update(minItems=len(context["targets"]), maxItems=len(context["targets"]))
        properties[task_id] = value_schema
        tasks.append({"id": task_id, "path": list(path), "field": path[-1],
                      "issues": [issue for issue in issues if tuple(issue["path"])[:len(path)] == path]})
    affected = sorted({path[1] for path in paths})
    return {
        "scenario_type": context["scenario_type"], "brief": context["brief"],
        "targets": context["targets"],
        **({"practice": context["practice"]} if context.get("practice") else {}),
        "scenes": [{"index": index, **{field: value for field, value in candidates[index].items()
                    if field in SCENE_FIELDS and isinstance(value, str) and len(value) <= 500}}
                   for index in affected],
        "repair_tasks": tasks,
        "reserved_titles": [candidate["title"] for index, candidate in enumerate(candidates)
                            if index not in affected and isinstance(candidate.get("title"), str)
                            and len(candidate["title"]) <= 120],
        "output_schema": {
            "type": "object", "additionalProperties": False, "required": ["repairs"],
            "properties": {"repairs": {"type": "object", "additionalProperties": False,
                                       "required": list(properties), "properties": properties}},
            "$defs": schema["$defs"],
        },
    }


def apply_repairs(document: dict, context: dict, raw: str) -> dict:
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate repair key")
            result[key] = value
        return result

    patch = json.loads(raw, object_pairs_hook=unique_keys)
    expected = {task["id"] for task in context["repair_tasks"]}
    if (not isinstance(patch, dict) or set(patch) != {"repairs"}
            or not isinstance(patch["repairs"], dict) or set(patch["repairs"]) != expected):
        raise ValueError("Repair must contain exactly the requested task IDs")
    updated = copy.deepcopy(document)
    for task in context["repair_tasks"]:
        target = updated
        for part in task["path"][:-1]:
            target = target[part]
        target[task["path"][-1]] = patch["repairs"][task["id"]]
    return updated
