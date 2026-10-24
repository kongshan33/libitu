"""Bounded opt-in Doubao planning + Supabase freeze smoke with synthetic records.

Run from apps/api:
    .venv/bin/python scripts/verify_speaking_planning.py --run-live
    .venv/bin/python scripts/verify_speaking_planning.py --run-live --ipv4 --output /tmp/planning-smoke.json
    .venv/bin/python scripts/verify_speaking_planning.py --run-live --ipv4 --support-level model_frame
    .venv/bin/python scripts/verify_speaking_planning.py --run-live --ipv4 --candidate-count 1 --support-level model_frame
    .venv/bin/python scripts/verify_speaking_planning.py --run-live --ipv4 --support-level no_hint --practice-variation details

This makes one planning API request, or two with --practice-variation (at most
two model calls per request if content repair is needed), and no feedback-model request. Identity
is substituted only inside this process; it does not verify Clerk sign-in, Gemini,
microphones, model quality or real learning. Runtime opportunity/exposure records
are explicit fixtures. No reliable learner speech is inserted, so a separately
running feedback worker also takes its existing no-model insufficient-data path.
Finally, delete only this run's random synthetic profile and verify its cascades.
"""

import argparse
from datetime import datetime, timezone
from copy import deepcopy
import json
import logging
import os
from pathlib import Path
import re
import sys
from time import monotonic, sleep
from uuid import uuid4

_INVOCATION_DIRECTORY = Path.cwd()
_API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_API_ROOT))
# Settings' existing relative .env lookup must also work from the repository root.
# This changes only the smoke process, never the user's persistent environment.
os.chdir(_API_ROOT)

from fastapi.testclient import TestClient
import httpx
from pydantic import ValidationError

from app.auth import AuthenticatedUser, require_user
from app.config import get_settings
from app.integrations.speaking_feedback_repository import get_feedback_store
from app.integrations.supabase_repository import get_supabase_repository
from app.main import app
from app.schemas.speaking import SpeakingSession
from app.schemas.speaking_plan import ScenarioProposals
from app.schemas.speaking_runtime import SpeakingWorkspace
from app.services import speaking_planning, speaking_runtime_state
from app.services.speaking_assessment import baseline_result
from app.services.speaking_feedback_service import request_feedback
from app.services.speaking_opportunities import set_target_skipped
from app.services.speaking_support import SUPPORT_LEVELS, effective_support
from app.services.speaking_support_runtime import SupportConflict, change_support
from app.services.speaking_teaching import AnalysisProviderError


class SmokeFailure(RuntimeError):
    """Only fixed, non-sensitive diagnostic codes are emitted."""


_EVENTS: list[dict] = []
_OUTPUT: Path | None = None
_MODEL_REQUESTS = 0
_MODEL_BUDGET = speaking_planning.MAX_GENERATION_ATTEMPTS
_PLAN_PHASE = "parent"
_TIMING_PHASES = {
    "input_read", "model_generation", "model_repair", "validation", "save_plan", "create",
    "workspace_session_read", "workspace_runtime_read", "total",
}


def check(condition: bool, code: str) -> None:
    if not condition:
        raise SmokeFailure(code)


def emit(event: str, **fields) -> None:
    record = {"event": event, **fields}
    _EVENTS.append(record)
    print(json.dumps(record, ensure_ascii=False), flush=True)
    if _OUTPUT is not None:
        _OUTPUT.write_text(json.dumps(_EVENTS, ensure_ascii=False, indent=2) + "\n")


def response_timing(response, code: str) -> None:
    """Retain only generated correlation IDs and allowlisted numeric durations."""
    header = response.headers.get("Server-Timing")
    if not header:
        return
    timings = {}
    for metric in header.split(","):
        match = re.fullmatch(r"\s*([a-z_]+);dur=(\d+(?:\.\d+)?)\s*", metric)
        if match and match[1] in _TIMING_PHASES and 0 <= float(match[2]) <= 180_000:
            timings[match[1]] = float(match[2])
    request_id = response.headers.get("X-Request-ID", "")
    emit("request_timing", operation=code, status_code=response.status_code,
         request_id=request_id if re.fullmatch(r"[a-f0-9]{32}", request_id) else None,
         durations_ms=timings)


def successful(response, status: int, code: str) -> dict:
    response_timing(response, code)
    if response.status_code != status and code in {"create_plan", "create_practice_plan"}:
        try:
            detail = response.json().get("detail")
        except (ValueError, AttributeError):
            detail = None
        categories = {
            speaking_planning.PLAN_UNAVAILABLE: "generation",
            speaking_planning.PLAN_TIMEOUT: "timeout",
            speaking_planning.PLAN_PROVIDER_UNAVAILABLE: "provider",
            speaking_planning.PLAN_INVALID_OUTPUT: "invalid_output",
            speaking_planning.PLAN_SAVE_UNAVAILABLE: "persistence",
            "Speaking sessions could not be saved or loaded. Please retry.": "persistence",
        }
        emit("planning_rejected", phase=_PLAN_PHASE, category=categories.get(detail, "other"),
             request_id=response.headers.get("X-Speaking-Plan-Request-ID"))
    check(response.status_code == status, f"{code}_http_{response.status_code}")
    return response.json()


def trace_provider(original):
    """Observe the real helper without logging prompts, headers, or raw outputs."""
    async def observed(*args, **kwargs):
        global _MODEL_REQUESTS
        _MODEL_REQUESTS += 1
        check(_MODEL_REQUESTS <= _MODEL_BUDGET, "model_request_budget")
        context = args[2] if len(args) > 2 else kwargs.get("context", {})
        is_repair = isinstance(context, dict) and bool(context.get("repair_tasks"))
        try:
            raw, trace = await original(*args, **kwargs)
        except AnalysisProviderError as error:
            emit("provider_failed", phase=_PLAN_PHASE, **{
                key: error.trace.get(key)
                for key in ("error_type", "elapsed_ms", "finish_reason", "usage")
            })
            raise
        emit("provider_completed", phase=_PLAN_PHASE, **{
            key: trace.get(key) for key in ("elapsed_ms", "finish_reason", "usage")
        })
        if is_repair:
            try:
                document = json.loads(raw)
            except (ValueError, TypeError):
                document = None
            repairs = document.get("repairs") if isinstance(document, dict) else None
            emit("provider_repair_summary", phase=_PLAN_PHASE, structured_repairs=isinstance(repairs, dict),
                 repaired_fields=len(repairs) if isinstance(repairs, dict) else 0)
            return raw, trace
        try:
            parsed = ScenarioProposals.model_validate_json(raw)
        except ValidationError as error:
            emit("provider_schema_failed", phase=_PLAN_PHASE, errors=speaking_planning._validation_diagnostics(error))
        else:
            # Only this script's synthetic language is sent to the model. Keep a
            # typed scenario snapshot so a save failure can be inspected offline,
            # without another paid request or retaining synthetic database rows.
            emit("provider_candidate_preview", phase=_PLAN_PHASE, candidates=[
                candidate.model_dump(mode="json") for candidate in parsed.candidates
            ])
        return raw, trace
    return observed


def replay_provider(path: Path):
    """Replay saved synthetic output, changing only this run's random target IDs."""
    records = json.loads(path.read_text())
    # A field-repair response is deliberately summary-only. Prefer the final
    # validated candidates so replay cannot resurrect the earlier bad field.
    previews = [row for row in records if row.get("event") == "validated_candidate_preview"]
    if not previews:
        previews = [row for row in records if row.get("event") == "provider_candidate_preview"]
    check(bool(previews), "replay_candidates_missing")
    saved = previews[-1]["candidates"]
    original_ids = [target["corpus_item_id"] for target in saved[0]["targets"]]
    check(len(set(original_ids)) == len(fixtures()), "replay_target_identity")

    async def replayed(_settings, _prompt, context, **_kwargs):
        current = context["targets"]
        check(len(current) == len(original_ids), "replay_target_count")
        identity = dict(zip(original_ids, [target["corpus_item_id"] for target in current], strict=True))
        candidates = deepcopy(saved)
        for candidate in candidates:
            check([target["corpus_item_id"] for target in candidate["targets"]] == original_ids,
                  "replay_target_order")
            check([target["role"] for target in candidate["targets"]] == [target["role"] for target in current],
                  "replay_target_roles")
            for target in candidate["targets"]:
                target["corpus_item_id"] = identity[target["corpus_item_id"]]
        emit("provider_replayed", source=path.name, candidates=len(candidates),
             content_changed=False, synthetic_ids_remapped=True, model_request=False)
        return json.dumps({"candidates": candidates}), {}
    return replayed


class PlanningDiagnostics(logging.Handler):
    def emit(self, record) -> None:
        if record.msg == "speaking_plan_generation %s" and len(record.args) == 1:
            emit("planning_diagnostic", diagnostic=json.loads(record.args[0]))


def fixtures() -> list[dict]:
    return [
        {
            "kind": "chunk", "text": "to be fair",
            "meaning": "Acknowledge a reasonable point before giving a different view.",
            "usage_context": "Concede a valid concern in a work discussion.",
            "tags": ["conceding", "softening"], "slots": {},
            "source_locator": {"source_title": "Synthetic scenario planning smoke", "snapshot": {
                "id": "fixture-concession", "kind": "chunk", "text": "to be fair",
                "tags": ["conceding"], "meta": "Synthetic fixture",
                "register": "professional", "scenario_tags": ["workplace", "disagreement"],
            }},
        },
        {
            "kind": "structure", "text": "Given [premise], we should [action]",
            "meaning": "Use a shared fact to justify a proposed next step.",
            "usage_context": "Connect a relevant constraint to a practical recommendation.",
            "tags": ["justifying", "proposing"],
            "slots": {"premise": "an agreed fact or constraint", "action": "a practical next step"},
            "source_locator": {"source_title": "Synthetic scenario planning smoke", "snapshot": {
                "id": "fixture-recommendation", "kind": "structure",
                "text": "Given [premise], we should [action]", "tags": ["justifying"],
                "meta": "Synthetic fixture", "register": "professional",
                "scenario_tags": ["workplace", "negotiation"], "pattern_family": "justified-claim",
            }},
        },
        {
            "kind": "idiom", "text": "on the same page",
            "meaning": "Share the same understanding of the decision.",
            "usage_context": "Confirm a shared understanding before ending a discussion.",
            "tags": ["clarifying"], "slots": {},
            "source_locator": {"source_title": "Synthetic scenario planning smoke", "snapshot": {
                "id": "fixture-understanding", "kind": "idiom", "text": "on the same page",
                "tags": ["clarifying"], "meta": "Synthetic fixture",
                "register": "neutral", "scenario_tags": ["workplace"],
            }},
        },
    ]


def simulated_runtime(session: dict, support: dict | None = None) -> dict:
    """Exercise persisted fields, without pretending these are provider events."""
    now = datetime.now(timezone.utc).isoformat()
    first, second, _opportunity = session["mission_plan"]["targets"]
    response_id, message_id = str(uuid4()), str(uuid4())
    document = {
        # No reliable learner turns: any external worker must avoid a paid assessment.
        "messages": [{
            "id": message_id, "ordinal": 0, "role": "assistant",
            "text": first["trigger_question"], "input_source": "text",
            "status": "final", "revision": 1, "response_id": response_id,
            "created_at": now,
        }],
        "evidence": [], "analysis_status": "idle",
        "controller": {"exposures": [{
            "id": str(uuid4()), "target_item_id": first["session_item_id"],
            "source_message_id": None, "source_revision": None, "after_turn": 0,
            "kind": "hint_card", "level": "usage", "scope": "session",
            "visible_at": now, "overlap": False, "response_id": response_id,
        }]},
        "teaching_attempts": [{
            "id": str(uuid4()), "response_id": response_id, "sent_at": now,
            "bound_at": now, "send_status": "sent", "presented": True, "presented_at": now,
            "policy": {
                "target_item_id": first["session_item_id"], "action": "implicit_elicitation",
                "provider_instruction": "synthetic-private-field-not-for-feedback",
            },
            "assessment": {"outcome": "reflected", "reason": "Synthetic projection fixture.",
                           "exact_quote": first["trigger_question"]},
        }],
        "private_probe_marker": "synthetic-private-field-not-for-feedback",
    }
    if support is not None:
        # A declared fixture proves persisted contracts, not real model behavior
        # or audio delivery. The first response is fully presented; a separate
        # optional target only has possible exposure from interrupted audio.
        model_quote = "To be fair, my team also needs time to review the changes."
        question = first["trigger_question"]
        document["messages"][0]["text"] = model_quote + " " + question
        attempt = document["teaching_attempts"][0]
        attempt["policy"].update(action="model_then_transfer", support_level=support["level"],
                                 support_version=support["version"])
        attempt["assessment"].update(model_quote=model_quote, transfer_question_quote=question)
        document["controller"]["exposures"][0]["level"] = "example"
        document["controller"]["exposures"].append({
            "id": str(uuid4()), "target_item_id": _opportunity["session_item_id"],
            "source_message_id": None, "source_revision": None, "after_turn": 0,
            "kind": "assistant_audio", "level": "example", "scope": "session", "certainty": "possible",
            "visible_at": now, "overlap": False, "response_id": str(uuid4()),
            "private_probe_marker": "synthetic-private-field-not-for-feedback",
        })
    set_target_skipped(document, second["session_item_id"], "Synthetic scenario no longer needs this target.", now)
    return document


def switch_support(owner: str, session: SpeakingSession, level: str, expected_version: int) -> dict:
    """Exercise the real hosted CAS and pure setter, without opening a provider socket."""
    now = datetime.now(timezone.utc).isoformat()
    state = speaking_runtime_state.mutate(
        owner, str(session.id),
        lambda document, _: change_support(session, document, level, expected_version, now),
    )
    support = effective_support(session, state["document"])
    check(support is not None and support["level"] == level, "runtime_support_switch")
    restored = speaking_runtime_state.read_state(owner, str(session.id))
    check(restored["document"] == state["document"], "runtime_support_recovery")
    return support


def verify_frozen_plan(source: dict, expected: dict) -> None:
    """Normalize optional schema defaults without changing or rewriting frozen JSON."""
    frozen_session = SpeakingSession.model_validate(source["session"])
    frozen_plan = frozen_session.mission_plan.model_dump(mode="json")
    check(frozen_plan == expected, "feedback_plan_snapshot")
    raw_plan = source["session"]["mission_plan"]
    if raw_plan != expected:
        emit("frozen_plan_defaults_normalized",
             absent_optional_parent_links=sum("parent_session_item_id" not in target
                                              for target in raw_plan["targets"]),
             semantic_plan_unchanged=True, persisted_source_rewritten=False)


def verify_source_mutations(client: TestClient, body: dict, session: dict) -> None:
    """A committed Mission survives source edits/deletion; new stale creation fails."""
    first_id = body["corpus_item_ids"][0]
    path = f"/api/speaking/sessions/{session['id']}"
    successful(client.patch(f"/api/corpus/{first_id}", json={"meaning": "Synthetic later edit."}), 200, "edit_source")
    check(client.post("/api/speaking/sessions", json={**body, "client_id": str(uuid4())}).status_code == 409,
          "stale_plan_rejected")
    check(successful(client.post("/api/speaking/sessions", json=body), 201, "retry_after_edit") == session,
          "immutable_after_source_edit")
    check(client.delete(f"/api/corpus/{first_id}").status_code == 204, "delete_source")
    recovered = successful(client.get(path), 200, "read_after_delete")
    check(recovered["items"][0]["corpus_item_id"] is None, "deleted_source_reference")
    check(recovered["mission_plan"] == session["mission_plan"], "plan_survives_source_delete")
    check(recovered["items"][0]["id"] == session["items"][0]["id"], "binding_survives_source_delete")
    check(successful(client.post("/api/speaking/sessions", json=body), 201, "retry_after_delete") == recovered,
          "retry_survives_source_delete")


def verify_practice(client: TestClient, owner: str, parent: dict, ids: list[str],
                    support_level: str, variation: str) -> None:
    """Generate one linked variant, then freeze only explicitly synthetic runtime facts."""
    global _PLAN_PHASE
    _PLAN_PHASE = "practice"
    path = f"/api/speaking/sessions/{parent['id']}/practice-plans"
    started = monotonic()
    plan = successful(client.post(path, json={"variation": variation}), 201, "create_practice_plan")
    check(2 <= len(plan["candidates"]) <= 3, "practice_candidate_count")
    check(successful(client.get(f"/api/speaking/plans/{plan['id']}"), 200, "read_practice_plan") == plan,
          "practice_plan_recovery")
    source = plan["practice_source"]
    check(source["parent_session_id"] == parent["id"] and source["root_session_id"] == parent["id"]
          and source["variation"] == variation and len(source["parent_snapshot_hash"]) == 64,
          "practice_source")
    original = parent["mission_plan"]
    fixture_items = fixtures()
    for candidate in plan["candidates"]:
        check([target["corpus_item_id"] for target in candidate["targets"]] == ids, "practice_target_order")
        check([target["role"] for target in candidate["targets"]] == ["primary", "primary", "opportunity"],
              "practice_target_roles")
        for target, fixture in zip(candidate["targets"], fixture_items, strict=True):
            check(speaking_planning._valid_sentence_frame(target.get("sentence_frame"), fixture),
                  "practice_sentence_frame")
        expected = [{"field": field, "before": original[field], "after": candidate[field]}
                    for field in ("setting", "goal", "user_role", "ai_role") if candidate[field] != original[field]]
        check(candidate["changes"] == expected and bool(expected), "practice_truthful_changes")
        if variation == "details":
            check(candidate["user_role"] == original["user_role"] and candidate["ai_role"] == original["ai_role"]
                  and any(row["field"] in {"setting", "goal"} for row in expected), "practice_details")
        else:
            check(candidate["user_role"] == original["ai_role"] and candidate["ai_role"] == original["user_role"],
                  "practice_role_swap")
    candidate = next((candidate for candidate in plan["candidates"] if all(
        target["fit"] in {"high", "medium"} for target in candidate["targets"] if target["role"] == "primary")), None)
    check(candidate is not None, "practice_no_confirmable_candidate")
    body = {
        "client_id": str(uuid4()), "scenario_type": plan["scenario_type"], "goal": candidate["goal"],
        "difficulty": "guided", "feedback_level": "balanced", "logic_template_id": None,
        "corpus_item_ids": ids, "plan_id": plan["id"], "candidate_id": candidate["id"],
    }
    check(client.post("/api/speaking/sessions", json=body).status_code == 422, "practice_support_required")
    body["support_level"] = support_level
    child = successful(client.post("/api/speaking/sessions", json=body), 201, "create_practice_session")
    child_path = f"/api/speaking/sessions/{child['id']}"
    check(successful(client.get(child_path), 200, "read_practice_session") == child, "practice_session_recovery")
    check(successful(client.post("/api/speaking/sessions", json=body), 201, "retry_practice_session") == child,
          "practice_session_idempotency")
    expected_practice = {
        "parent_session_id": parent["id"], "root_session_id": parent["id"],
        "variation": variation, "changes": candidate["changes"],
    }
    check(child["practice"] == expected_practice, "practice_frozen_link")
    check(child["support_level"] == support_level and child["evidence_contract_version"] == "speaking-evidence-v3",
          "practice_explicit_evidence_contract")
    for target, parent_target, item, corpus_id in zip(child["mission_plan"]["targets"], original["targets"],
                                                     child["items"], ids, strict=True):
        check(target["session_item_id"] == item["id"] and target["session_item_id"] != parent_target["session_item_id"]
              and target["parent_session_item_id"] == parent_target["session_item_id"], "practice_stable_target_mapping")
        check(item["source_corpus_item_id"] == corpus_id, "practice_stable_corpus_identity")
    initial_workspace = speaking_runtime_state.public_workspace(owner, child["id"])
    check(initial_workspace.support.model_dump() == {"level": support_level, "version": 0}, "practice_initial_support")
    fixture = simulated_runtime(child)
    def apply_fixture(document, _state):
        document.update(fixture)
        return "active"
    speaking_runtime_state.mutate(owner, child["id"], apply_fixture)
    speaking_runtime_state.end_session(owner, child["id"])
    requested = request_feedback(owner, child["id"])
    job = get_feedback_store().read(owner, child["id"])
    frozen = job["source"]
    check(frozen["session"]["practice"] == expected_practice, "practice_feedback_link")
    verify_frozen_plan(frozen, child["mission_plan"])
    check(frozen["session"]["evidence_contract_version"] == "speaking-evidence-v3"
          and [item["source_corpus_item_id"] for item in frozen["session"]["items"]] == ids,
          "practice_feedback_identity")
    check(baseline_result(frozen).statistics.assessed_turns == 0, "practice_no_feedback_model_input")
    frozen_hash = job["input_hash"]
    emit("practice_frozen", elapsed_seconds=round(monotonic() - started, 2), variation=variation,
         parent_session_id=parent["id"], child_session_id=child["id"], plan_id=plan["id"],
         candidates=len(plan["candidates"]), chosen_scene={
             key: candidate[key] for key in ("title", "setting", "goal", "user_role", "ai_role", "changes")
         }, support_level=support_level, stable_source_ids=True, stable_parent_item_mapping=True,
         explicit_support_required=True, feedback_job_id=requested.id, reliable_user_turns=0,
         feedback_model_called=False, runtime_receipts="synthetic_fixture")
    # Source mutation/deletion and parent deletion cannot rewrite a committed child.
    completed = successful(client.get(child_path), 200, "read_completed_practice")
    verify_source_mutations(client, body, completed)
    check(client.delete(f"/api/speaking/sessions/{parent['id']}").status_code == 204, "delete_practice_parent")
    recovered = successful(client.post("/api/speaking/sessions", json=body), 201, "retry_practice_after_parent_delete")
    check(recovered["practice"] == {**expected_practice, "parent_session_id": None},
          "practice_parent_deletion_nullable")
    check(recovered["items"][0]["corpus_item_id"] is None
          and recovered["items"][0]["source_corpus_item_id"] == ids[0], "practice_source_deletion_stable_identity")
    unchanged = get_feedback_store().read(owner, child["id"])
    check(unchanged["input_hash"] == frozen_hash and unchanged["source"] == frozen, "practice_frozen_source_unchanged")
    emit("practice_recovery_verified", source_deleted=True, parent_deleted=True,
         committed_retry_recovered=True, parent_reference_null=True, frozen_feedback_unchanged=True)


def verify_chain(client: TestClient, owner: str, support_level: str | None = None,
                 practice_variation: str | None = None, candidate_count: int = 2) -> None:
    fixture_items = fixtures()
    ids = []
    for fixture in fixture_items:
        created = successful(client.post("/api/corpus", json=fixture), 201, "create_corpus")
        ids.append(created["id"])
    emit("corpus_created", count=len(ids))
    plan_body = {
        "scenario_type": "workplace",
        "candidate_count": candidate_count,
        "brief": "Discuss a delayed project with a colleague, acknowledge their constraint, and agree on a practical next step.",
        "targets": [{"corpus_item_id": item_id, "role": "primary" if index < 2 else "opportunity"}
                    for index, item_id in enumerate(ids)],
    }
    started = monotonic()
    plan = successful(client.post("/api/speaking/plans", json=plan_body), 201, "create_plan")
    check(len(plan["candidates"]) == candidate_count, "candidate_count")
    emit("validated_candidate_preview", phase=_PLAN_PHASE, candidates=[
        {key: value for key, value in candidate.items() if key not in {"id", "changes"}}
        for candidate in plan["candidates"]
    ])
    restored_plan = successful(client.get(f"/api/speaking/plans/{plan['id']}"), 200, "read_plan")
    check(restored_plan == plan, "plan_recovery")
    for candidate in plan["candidates"]:
        check([target["corpus_item_id"] for target in candidate["targets"]] == ids, "candidate_target_order")
        check([target["role"] for target in candidate["targets"]] == ["primary", "primary", "opportunity"], "candidate_roles")
        check(all(target["metadata_status"] == "available" for target in candidate["targets"]), "source_metadata_status")
        for target, fixture in zip(candidate["targets"], fixture_items, strict=True):
            check(speaking_planning._valid_sentence_frame(target.get("sentence_frame"), fixture),
                  "candidate_sentence_frame")
    emit("plan_created", elapsed_seconds=round(monotonic() - started, 2),
         plan_id=plan["id"], candidates=[{
             "title": candidate["title"], "goal": candidate["goal"],
             "user_role": candidate["user_role"], "ai_role": candidate["ai_role"],
             "primary_fit": [target["fit"] for target in candidate["targets"] if target["role"] == "primary"],
             "implicit_targets": [{
                 key: target[key] for key in (
                     "role", "communicative_function", "trigger_question", "skip_when", "sentence_frame",
                 )
             } for target in candidate["targets"]],
         } for candidate in plan["candidates"]])
    candidate = next((candidate for candidate in plan["candidates"] if all(
        target["fit"] in {"high", "medium"} for target in candidate["targets"] if target["role"] == "primary")), None)
    check(candidate is not None, "no_confirmable_candidate")
    body = {
        "client_id": str(uuid4()), "scenario_type": plan["scenario_type"], "goal": candidate["goal"],
        "difficulty": "guided", "feedback_level": "balanced", "logic_template_id": None,
        "corpus_item_ids": ids, "plan_id": plan["id"], "candidate_id": candidate["id"],
    }
    if support_level is not None:
        body["support_level"] = support_level
    session = successful(client.post("/api/speaking/sessions", json=body), 201, "create_session")
    sid = session["id"]
    path = f"/api/speaking/sessions/{sid}"
    initial_workspace = SpeakingWorkspace.model_validate(successful(
        client.get(path + "/workspace"), 200, "read_workspace",
    ))
    check(successful(client.get(path), 200, "read_session") == session, "session_recovery")
    check(successful(client.post("/api/speaking/sessions", json=body), 201, "retry_session") == session,
          "session_idempotency")
    check(session.get("support_level") == support_level, "frozen_initial_support")
    conflicting_level = "no_hint" if support_level != "no_hint" else "model_frame"
    check(client.post("/api/speaking/sessions", json={**body, "support_level": conflicting_level}).status_code == 409,
          "support_idempotency_conflict")
    check(session["mission_plan"]["plan_id"] == plan["id"], "frozen_plan_id")
    check(session["mission_plan"]["candidate_id"] == candidate["id"], "frozen_candidate_id")
    check(session["mission_plan"]["goal"] == candidate["goal"], "frozen_goal")
    for target, planned, item, fixture in zip(session["mission_plan"]["targets"], candidate["targets"],
                                             session["items"], fixture_items, strict=True):
        check(target["session_item_id"] == item["id"], "stable_target_binding")
        check(target["sentence_frame"] == planned["sentence_frame"], "frozen_sentence_frame")
        check(item["usage_note"] == fixture["usage_context"], "usage_snapshot")
        snapshot = fixture["source_locator"]["snapshot"]
        check(item["register"] == snapshot["register"], "register_snapshot")
        check(item["scenario_tags"] == snapshot["scenario_tags"], "scenario_snapshot")
        check(item["pattern_family"] == snapshot.get("pattern_family"), "pattern_snapshot")
    if practice_variation is None:
        verify_source_mutations(client, body, session)
    emit("session_frozen", session_id=sid, metadata=True, stable_target_ids=True,
         stale_plan_check="verified" if practice_variation is None else "deferred_until_child_creation",
         support_level=support_level, support_idempotency=True, sentence_frames=True)

    typed_session = SpeakingSession.model_validate(session)
    initial_support = {"level": support_level, "version": 0} if support_level is not None else None
    check((initial_workspace.support.model_dump() if initial_workspace.support else None) == initial_support,
          "runtime_initial_support")
    active_support = switch_support(owner, typed_session, "model_frame", 0) if support_level is not None else None
    runtime_fixture = simulated_runtime(session, active_support)
    def apply_fixture(document, _state):
        document.update(runtime_fixture)
        return "active"
    speaking_runtime_state.mutate(owner, sid, apply_fixture)
    workspace = speaking_runtime_state.public_workspace(owner, sid)
    check([row.status for row in workspace.opportunities] == ["offered", "skipped", "planned"], "opportunity_projection")
    if active_support is not None:
        check(len(workspace.demonstrations) == 1, "presented_model_projection")
        support = switch_support(owner, typed_session, "no_hint", active_support["version"])
        check(support["version"] == active_support["version"] + 1, "runtime_support_version")
        before_retry = speaking_runtime_state.read_state(owner, sid)["document"]
        check(switch_support(owner, typed_session, "no_hint", support["version"]) == support, "support_switch_idempotency")
        check(speaking_runtime_state.read_state(owner, sid)["document"] == before_retry, "support_history_idempotency")
        try:
            switch_support(owner, typed_session, "label_only", active_support["version"])
        except SupportConflict:
            pass
        else:
            raise SmokeFailure("stale_support_version_accepted")
        check(speaking_runtime_state.read_state(owner, sid)["document"] == before_retry, "stale_support_left_unchanged")
        workspace = speaking_runtime_state.public_workspace(owner, sid)
        check(workspace.support.model_dump() == support and workspace.demonstrations == [], "no_hint_projection")
        check(successful(client.get(path), 200, "read_initial_support")["support_level"] == support_level,
              "initial_support_unchanged")
        emit("runtime_support_verified", initial=support_level, current=support,
             modeled_support=active_support, stale_version_rejected=True, change_idempotent=True,
             transport="direct_runtime_cas_fixture", provider_socket_opened=False)
    speaking_runtime_state.end_session(owner, sid)
    requested = request_feedback(owner, sid)
    duplicate = request_feedback(owner, sid)
    check(requested.id == duplicate.id and requested.input_hash == duplicate.input_hash, "feedback_idempotency")
    job = get_feedback_store().read(owner, sid)
    check(job is not None, "feedback_read")
    source = job["source"]
    verify_frozen_plan(source, session["mission_plan"])
    check(source["teaching_attempts"][0]["assessment"]["outcome"] == "reflected", "feedback_reflection")
    check(source["teaching_attempts"][0]["presented"] is True, "feedback_presentation")
    skipped_id = session["mission_plan"]["targets"][1]["session_item_id"]
    check(source["target_states"][skipped_id]["skipped"] is True, "feedback_skipped")
    check(source["target_states"][skipped_id]["history"][0]["action"] == "skip", "feedback_skip_history")
    check(source["controller"]["exposures"][0]["level"] == ("example" if active_support else "usage"), "feedback_exposure")
    check(source["controller"]["exposures"][0]["target_item_id"] == session["items"][0]["id"], "feedback_exposure_binding")
    check("synthetic-private-field-not-for-feedback" not in json.dumps(source), "private_fields_excluded")
    check(baseline_result(source).statistics.assessed_turns == 0, "no_feedback_model_input")
    check(get_feedback_store().read(owner + "-unrelated", sid) is None, "feedback_owner_isolation")
    if active_support is not None:
        check(source["session"]["support_level"] == support_level, "feedback_initial_support")
        check(source["support"] == support, "feedback_current_support")
        check(source["support_history"] == before_retry["support_history"], "feedback_support_history")
        frozen_attempt = source["teaching_attempts"][0]
        check(frozen_attempt["policy"]["support_level"] == "model_frame", "feedback_policy_support")
        check(frozen_attempt["policy"]["support_version"] == active_support["version"], "feedback_policy_support_version")
        check(frozen_attempt["assessment"] == runtime_fixture["teaching_attempts"][0]["assessment"],
              "feedback_model_transfer_quotes")
        possible = [row for row in source["controller"]["exposures"] if row.get("certainty") == "possible"]
        check(len(possible) == 1 and possible[0]["scope"] == "session"
              and possible[0]["target_item_id"] == session["items"][2]["id"], "feedback_partial_audio_certainty")
        emit("support_feedback_frozen", initial_support=True, current_support=True, support_history=True,
             policy_support_version=True, model_quote=True, transfer_question_quote=True,
             possible_audio_certainty=True, fixture_receipts_only=True)
    emit("feedback_frozen", job_id=job["id"], status=job["status"],
         reflected=True, presented=True, skipped=True, exposure=True,
         private_fields_excluded=True, reliable_user_turns=0, feedback_model_called=False)
    if practice_variation is not None:
        verify_practice(client, owner, session, ids, support_level, practice_variation)


def cleanup(database, owner: str) -> None:
    """Owner-bound cascade also handles an uncertain create whose response was lost."""
    session_ids = []
    try:
        rows = database._request("GET", "/speaking_sessions",
                                 params={"user_id": f"eq.{owner}", "select": "id"}).json()
        session_ids = [row["id"] for row in rows]
    except Exception:
        # Still attempt profile deletion; never turn a failed read into skipped cleanup.
        pass
    deletion_succeeded = False
    for attempt in range(3):
        try:
            database._request("DELETE", "/profiles", params={"id": f"eq.{owner}"})
            deletion_succeeded = True
            break
        except Exception:
            if attempt < 2:
                sleep(0.25 * (attempt + 1))
    check(deletion_succeeded, "cleanup_delete_failed")
    for table, column in [("profiles", "id"), ("corpus_items", "user_id"),
                          ("speaking_plans", "user_id"), ("speaking_sessions", "user_id")]:
        remaining = database._request("GET", f"/{table}",
                                      params={column: f"eq.{owner}", "select": "id", "limit": "1"}).json()
        check(remaining == [], f"cleanup_{table}_remains")
    if session_ids:
        selection = "in.(" + ",".join(session_ids) + ")"
        for table in ["speaking_session_items", "speaking_runtime_state", "speaking_feedback", "speaking_turns"]:
            remaining = database._request("GET", f"/{table}",
                                          params={"session_id": selection, "select": "session_id", "limit": "1"}).json()
            check(remaining == [], f"cleanup_{table}_remains")
    emit("cleanup_verified", profiles=0, corpus_items=0, plans=0, sessions=0, known_session_dependents=0)


def main() -> None:
    global _OUTPUT, _MODEL_BUDGET
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-live", action="store_true", required=True)
    parser.add_argument("--ipv4", action="store_true",
                        help="Bind only this smoke's Supabase client to IPv4, preserving TLS verification.")
    parser.add_argument("--output", type=Path, help="Write only safe JSON event records to this file.")
    parser.add_argument("--support-level", choices=sorted(SUPPORT_LEVELS), default=None,
                        help="Freeze this initial setting and verify support transitions; omission preserves the legacy request.")
    parser.add_argument("--candidate-count", type=int, choices=(1, 2), default=2,
                        help="Request one automatic scene or two comparison scenes; default is two.")
    parser.add_argument("--replay-events", type=Path,
                        help="Replay saved synthetic candidate previews instead of calling a model; Supabase remains live.")
    parser.add_argument("--practice-variation", choices=("details", "role_swap"),
                        help="Generate one linked practice plan after completing the synthetic parent Mission.")
    args = parser.parse_args()
    if args.practice_variation and (args.support_level is None or args.replay_events):
        parser.error("--practice-variation requires explicit --support-level and does not support --replay-events.")
    planning_requests = 2 if args.practice_variation else 1
    _MODEL_BUDGET = planning_requests * speaking_planning.MAX_GENERATION_ATTEMPTS
    if args.output is not None:
        _OUTPUT = (args.output if args.output.is_absolute() else _INVOCATION_DIRECTORY / args.output).resolve()
        _OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    settings = get_settings()
    if not settings.supabase_server_is_configured or (not args.replay_events and not settings.ark_is_configured):
        parser.error("Configure server Supabase and the existing Doubao provider before this smoke.")
    replay_path = ((args.replay_events if args.replay_events.is_absolute()
                    else _INVOCATION_DIRECTORY / args.replay_events).resolve()) if args.replay_events else None
    if replay_path is not None:
        check(_OUTPUT != replay_path, "replay_output_must_differ")
    database = get_supabase_repository()
    check(database is not None, "durable_database_unavailable")
    if args.ipv4:
        # Connection retries happen before request delivery; neither an HTTP error
        # nor a lost response causes a replay. Each planning API is called once;
        # its bounded content-repair policy and provider client are unchanged.
        previous_client = database._client
        database._client = httpx.Client(
            base_url=database._rest_url, headers=database._headers,
            transport=httpx.HTTPTransport(local_address="0.0.0.0", retries=1),
            timeout=httpx.Timeout(20.0, connect=10.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
        previous_client.close()
    owner = "libitu-planning-smoke-" + uuid4().hex
    previous_override = app.dependency_overrides.get(require_user)
    previous_provider = speaking_planning.request_analysis_json
    speaking_planning.request_analysis_json = replay_provider(replay_path) if replay_path else trace_provider(previous_provider)
    diagnostics_handler = PlanningDiagnostics()
    speaking_planning._LOGGER.addHandler(diagnostics_handler)
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=owner)
    passed = False
    emit("started", synthetic_owner=owner, planning_requests=planning_requests,
         max_model_requests=0 if replay_path else _MODEL_BUDGET,
         provider_mode="saved_synthetic_replay" if replay_path else "live",
         identity="synthetic_dependency",
         supabase_transport="ipv4_verified_tls" if args.ipv4 else "default_verified_tls",
         support_level=args.support_level, practice_variation=args.practice_variation,
         candidate_count=args.candidate_count)
    try:
        check(database._request("GET", "/profiles", params={
            "id": f"eq.{owner}", "select": "id", "limit": "1",
        }).json() == [], "synthetic_owner_collision")
        emit("connection_verified")
        with TestClient(app) as client:
            verify_chain(client, owner, args.support_level, args.practice_variation, args.candidate_count)
        passed = True
    except (Exception, KeyboardInterrupt) as error:
        emit("failed", code=str(error) if isinstance(error, SmokeFailure) else type(error).__name__)
    finally:
        speaking_planning.request_analysis_json = previous_provider
        speaking_planning._LOGGER.removeHandler(diagnostics_handler)
        if previous_override is None:
            app.dependency_overrides.pop(require_user, None)
        else:
            app.dependency_overrides[require_user] = previous_override
        try:
            cleanup(database, owner)
        except Exception as error:
            passed = False
            emit("cleanup_failed", synthetic_owner=owner,
                 code=str(error) if isinstance(error, SmokeFailure) else type(error).__name__)
    emit("completed", passed=passed, model_requests=_MODEL_REQUESTS,
         provider_mode="saved_synthetic_replay" if replay_path else "live",
         qualification="planning_and_persistence_only")
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
