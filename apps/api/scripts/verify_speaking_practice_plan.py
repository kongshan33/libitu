"""One opt-in real linked-planning request with synthetic parent and no database.

Only the input-loading and save boundaries are replaced with process-local
fixtures. The production create_practice_plan path, prompt, bounded repair and
strict target/variation checks remain intact. At most two model calls share
the existing 90-second planning deadline. No Mission, feedback or audio runs.
"""
from __future__ import annotations

import argparse
import asyncio
from copy import deepcopy
import json
import logging
import os
from pathlib import Path
import sys
from time import monotonic

_API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_API_ROOT))

from app.schemas.speaking import SpeakingSession
from app.schemas.speaking_plan import PracticePlanCreate, SpeakingPlanCreate
from app.services import speaking_planning as planning
from scripts.verify_speaking_review import synthetic_source


async def run_probe() -> dict:
    parent = SpeakingSession.model_validate(synthetic_source()["session"])
    before = parent.model_dump(mode="json")
    owner, parent_id = parent.user_id, str(parent.id)
    request = SpeakingPlanCreate(
        scenario_type=parent.scenario_type,
        targets=[{"corpus_item_id": target.corpus_item_id, "role": target.role}
                 for target in parent.mission_plan.targets],
    )
    snapshots = [{
        "corpus_item_id": str(item.corpus_item_id), "kind": item.kind, "text": item.text,
        "meaning": item.meaning, "usage_note": item.usage_note, "tags": list(item.tags),
        "slots": dict(item.slots), "source_title": item.source_title, "register": item.usage_register,
        "scenario_tags": list(item.scenario_tags), "pattern_family": item.pattern_family,
    } for item in parent.items]
    planning._match_parent_language(parent, snapshots)
    trace = {"model_requests": 0, "calls": [], "diagnostics": []}
    original_load, original_save = planning._load_practice_inputs, planning._save_plan
    original_request = planning.request_analysis_json
    saved = []

    def load_inputs(actual_owner, actual_parent, payload):
        if (actual_owner, actual_parent, payload.variation) != (owner, parent_id, "details"):
            raise ValueError("fixture_identity_mismatch")
        return parent.model_copy(deep=True), request.model_copy(deep=True), deepcopy(snapshots)

    def save_plan(actual_owner, plan, actual_snapshots):
        if actual_owner != owner or actual_snapshots != snapshots:
            raise ValueError("fixture_save_mismatch")
        saved.append(plan.model_copy(deep=True))
        return plan

    async def observed(*args, **kwargs):
        trace["model_requests"] += 1
        if trace["model_requests"] > planning.MAX_GENERATION_ATTEMPTS:
            raise ValueError("probe_model_budget")
        try:
            raw, metadata = await original_request(*args, **kwargs)
        except Exception as error:
            trace["calls"].append({"error_type": type(error).__name__})
            raise
        trace["calls"].append({key: metadata.get(key) for key in ("elapsed_ms", "finish_reason", "usage")})
        return raw, metadata

    class Diagnostics(logging.Handler):
        def emit(self, record):
            if record.msg == "speaking_plan_generation %s" and len(record.args) == 1:
                trace["diagnostics"].append(json.loads(record.args[0]))

    handler = Diagnostics()
    planning._LOGGER.addHandler(handler)
    planning._load_practice_inputs, planning._save_plan = load_inputs, save_plan
    planning.request_analysis_json = observed
    started = monotonic()
    event = {
        "fixture": "synthetic_review_deadline", "synthetic": True, "database_calls": 0,
        "planning_requests": 1, "max_model_requests": planning.MAX_GENERATION_ATTEMPTS,
        "variation": "details", "persistence": "process_local_fixture",
        "qualification": "real_child_generation_and_strict_validation_only",
    }
    try:
        plan = await planning.create_practice_plan(owner, parent_id, PracticePlanCreate(variation="details"))
        if len(saved) != 1 or saved[0] != plan:
            raise ValueError("fixture_save_not_once")
        source = plan.practice_source
        if (str(source.parent_session_id) != parent_id or str(source.root_session_id) != parent_id
                or source.variation != "details" or source.parent_snapshot_hash != planning._parent_snapshot_hash(parent)):
            raise ValueError("practice_source_mismatch")
        candidates = []
        for candidate in plan.candidates:
            expected_changes = [
                {"field": field, "before": getattr(parent.mission_plan, field), "after": getattr(candidate, field)}
                for field in ("setting", "goal", "user_role", "ai_role")
                if getattr(parent.mission_plan, field) != getattr(candidate, field)
            ]
            if (candidate.user_role != parent.mission_plan.user_role
                    or candidate.ai_role != parent.mission_plan.ai_role
                    or [row.model_dump() for row in candidate.changes] != expected_changes
                    or not any(row["field"] in {"setting", "goal"} for row in expected_changes)):
                raise ValueError("practice_changes_mismatch")
            if ([target.corpus_item_id for target in candidate.targets] != [target.corpus_item_id for target in request.targets]
                    or [target.role for target in candidate.targets] != [target.role for target in request.targets]):
                raise ValueError("practice_targets_mismatch")
            candidates.append({
                "title": candidate.title, "setting": candidate.setting, "goal": candidate.goal,
                "user_role": candidate.user_role, "ai_role": candidate.ai_role,
                "changes": expected_changes,
                "primary_fit": [target.fit for target in candidate.targets if target.role == "primary"],
                "confirmable": all(target.fit in {"high", "medium"} for target in candidate.targets
                                   if target.role == "primary"),
            })
        event.update(
            passed=any(candidate["confirmable"] for candidate in candidates), candidates=candidates,
            strict_validation=True, target_identity_preserved=True, target_roles_preserved=True,
            source_link_verified=True, saved_once=True, parent_unchanged=parent.model_dump(mode="json") == before,
        )
    except Exception as error:
        event.update(passed=False, error_type=type(error).__name__)
        headers = getattr(error, "headers", None)
        if isinstance(headers, dict):
            code = headers.get("X-Speaking-Plan-Error")
            if code in planning._REPAIR_REQUIREMENTS or code in {"timeout", "provider_unavailable"}:
                event["error_category"] = code
    finally:
        planning._load_practice_inputs, planning._save_plan = original_load, original_save
        planning.request_analysis_json = original_request
        planning._LOGGER.removeHandler(handler)
    event["provider"] = trace
    event["elapsed_ms"] = round((monotonic() - started) * 1000, 2)
    event["cleanup"] = "no_persistent_records_created"
    return event


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-live", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.run_live:
        parser.error("--run-live is required; this probe incurs one planning request with at most one repair.")
    output = args.output.resolve() if args.output else None
    os.chdir(_API_ROOT)
    event = asyncio.run(run_probe())
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(event, ensure_ascii=False))
    return 0 if event.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
