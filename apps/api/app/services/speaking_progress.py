"""Evidence-based support suggestions and factual linked-round comparisons."""

import hashlib
import json
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException
from pydantic import ValidationError

from app.integrations.speaking_feedback_repository import get_feedback_store
from app.integrations.speaking_progress_repository import read_support_history
from app.schemas.speaking import EVIDENCE_CONTRACT_VERSION
from app.schemas.speaking_feedback import SUPPORTED_REPORT_VERSIONS
from app.schemas.speaking_progress import (
    PracticeComparison, PracticeComparisonItem, PracticeEvidence, PracticeUseSummary,
    SupportRecommendation, SupportRecommendationRequest, SupportTargetHistory,
)
from app.services.corpus_service import get_corpus_item
from app.services.speaking_assessment import validate_reference
from app.services.speaking_feedback_service import public_feedback
from app.services.speaking_runtime_state import require_session
from app.services.speaking_service import _repository, get_speaking_session

_LEVELS = ("model_frame", "model_label", "label_only", "no_hint")


def language_identity(item: dict) -> str:
    """Only language content is identity; editing metadata does not erase practice."""
    content = {key: item.get(key) for key in ("kind", "text", "meaning")}
    content["slots"] = item.get("slots") or {}
    encoded = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _reliable_messages(messages: list[dict]) -> list[dict]:
    latest = {}
    for message in messages:
        if not isinstance(message, dict) or not isinstance(message.get("id"), str):
            continue
        previous = latest.get(message["id"])
        revision = message.get("revision")
        if type(revision) is not int:
            continue
        if previous is None or revision >= previous.get("revision", 0):
            latest[message["id"]] = message
    return [message for message in latest.values()
            if message.get("role") == "user" and message.get("status") == "final"]


def _qualifying_time(report: dict, target: dict, identity: str) -> datetime | None:
    result = target.get("result") or {}
    item = target.get("item") or {}
    if (report.get("status") != "ready"
            or report.get("analysis_version") != "speaking-feedback-v3"
            or report.get("rubric_version") != "speaking-rubric-v2"
            or report.get("evidence_contract_version") != EVIDENCE_CONTRACT_VERSION
            or target.get("target_role") != "primary" or result.get("role") != "primary"
            or target.get("skipped") is not False
            or result.get("opportunity_status") == "skipped" or result.get("excluded_reason")
            or result.get("status") != "appropriate" or result.get("independent_uses", 0) < 1
            or item.get("id") != result.get("session_item_id")
            or language_identity(item) != identity):
        return None
    messages = _reliable_messages(target.get("messages") or [])
    times = []
    for ref in result.get("qualifying_independent_evidence") or []:
        if not isinstance(ref, dict) or validate_reference(ref, messages) is None:
            continue
        message = next(row for row in messages if row["id"] == ref["message_id"])
        # Use actual independent speech, never session creation or report retry time.
        value = message.get("finalized_at") or message.get("started_at") or message.get("created_at")
        try:
            timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if timestamp.tzinfo is not None:
                times.append(timestamp)
        except (ValueError, AttributeError):
            continue
    return min(times) if times else None


def _scene_roots(reports: list[dict]) -> int:
    """Linked variants and exact scene repetitions both count as one scene family."""
    groups: list[set[str]] = []
    for report in reports:
        scene = report.get("scene") or {}
        if not all(isinstance(scene.get(key), str) and scene[key].strip()
                   for key in ("setting", "goal", "user_role", "ai_role")):
            continue
        normalized = {key: " ".join(value.lower().split()) for key, value in scene.items()}
        scene_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()
        tokens = {f"root:{report['root_session_id']}", f"scene:{scene_hash}"}
        connected = [group for group in groups if group & tokens]
        for group in connected:
            tokens.update(group)
            groups.remove(group)
        groups.append(tokens)
    return len(groups)


def recommend_support(owner: str, request: SupportRecommendationRequest) -> SupportRecommendation:
    # Enforce the configured durable-store boundary before loading selected language.
    _repository()
    identities = {}
    for selection in request.targets:
        item = get_corpus_item(owner, str(selection.corpus_item_id))
        if item is None:
            raise HTTPException(404, "Selected language is unavailable. Refresh your library.")
        identities[str(selection.corpus_item_id)] = language_identity(item.model_dump(mode="json"))
    history = read_support_history(owner, list(identities))
    targets = []
    for selection in request.targets:
        corpus_id = str(selection.corpus_item_id)
        qualifying = {}
        for report in history["reports"]:
            try:
                # Invalid legacy/projection rows contribute no evidence.
                UUID(report["session_id"])
                UUID(report["id"])
                UUID(report["root_session_id"])
                times = [_qualifying_time(report, target, identities[corpus_id])
                         for target in report.get("items", [])
                         if (target.get("item") or {}).get("source_corpus_item_id") == corpus_id]
                times = [timestamp for timestamp in times if timestamp is not None]
                if times:
                    qualifying[report["session_id"]] = (report, min(times))
            except (KeyError, TypeError, ValueError, AttributeError):
                continue
        days = {date.astimezone(timezone.utc).date() for _, date in qualifying.values()}
        roots = _scene_roots([report for report, _ in qualifying.values()])
        targets.append(SupportTargetHistory(
            corpus_item_id=selection.corpus_item_id, role=selection.role,
            qualifying_missions=len(qualifying), practice_days=len(days), scene_roots=roots,
            eligible=len(qualifying) >= 3 and len(days) >= 2 and roots >= 2,
            evidence=[PracticeEvidence(session_id=row["session_id"], report_id=row["id"], practiced_at=date)
                      for row, date in list(qualifying.values())[:5]],
        ))
    status = "insufficient_history"
    suggested = None
    reason = ("Each primary target needs reliable independent use in at least three missions, "
              "across two UTC practice dates and two different scene families. "
              "Linked rounds and exact repeats count as one scene family.")
    if request.current_level == "no_hint":
        status, reason = "keep_current", "You already chose no proactive hints. Requested help remains available."
    elif request.current_level is None:
        status, reason = "keep_current", "Choose a support level before requesting a reduction suggestion."
    elif all(target.eligible for target in targets if target.role == "primary"):
        status = "suggest_reduce"
        suggested = _LEVELS[_LEVELS.index(request.current_level) + 1]
        reason = ("Your primary targets meet the repeated independent-use threshold. "
                  "You can try one less level of support; this is a practice suggestion, not a mastery rating.")
    return SupportRecommendation(
        status=status, suggested_level=suggested, current_level=request.current_level,
        as_of=datetime.now(timezone.utc), history_truncated=history["has_more"], targets=targets, reason=reason,
    )


def compare_practice(owner: str, child_id: str) -> PracticeComparison:
    child = require_session(owner, child_id)
    response = PracticeComparison(
        status="unavailable", reason="This mission has no available earlier practice round.",
        child_session_id=child.id, child_support_level=child.support_level,
    )
    if not child.practice or not child.practice.parent_session_id:
        return response
    parent = get_speaking_session(owner, str(child.practice.parent_session_id))
    if parent is None:
        return response
    response.parent_session_id = parent.id
    response.parent_support_level = parent.support_level
    if parent.status != "completed" or child.status != "completed":
        response.status, response.reason = "pending", "Complete both rounds before comparing their reports."
        return response
    adapter = get_feedback_store()
    jobs = [adapter.read(owner, str(session.id)) for session in (parent, child)]
    if any(job is None or job["status"] in ("queued", "processing") for job in jobs):
        response.status, response.reason = "pending", "Both existing reports must be ready before comparison."
        return response
    if any(job["status"] != "ready" for job in jobs):
        response.reason = "One report is incomplete or unavailable; no comparison was inferred."
        return response
    if any(job["rubric_version"] != "speaking-rubric-v2"
           or (job["rubric_version"], job["analysis_version"]) not in SUPPORTED_REPORT_VERSIONS for job in jobs):
        response.status, response.reason = "incompatible", "These report versions cannot be compared."
        return response
    before, after = [public_feedback(job) for job in jobs]
    response.parent_support_level = before.effective_support_level
    response.child_support_level = after.effective_support_level
    if not before.session.mission_plan or not after.session.mission_plan or not before.result or not after.result:
        response.status, response.reason = "incompatible", "The reports do not contain matching frozen target plans."
        return response
    before_items = {str(item.id): item for item in before.session.items}
    before_targets = {str(target.session_item_id): target for target in before.session.mission_plan.targets}
    after_items = {str(item.id): item for item in after.session.items}
    before_results = {row.session_item_id: row for row in before.result.item_results}
    after_results = {row.session_item_id: row for row in after.result.item_results}
    items = []
    try:
        if len(before_items) != len(after_items):
            raise ValueError
        seen_parents = set()
        for target in after.session.mission_plan.targets:
            parent_id = str(target.parent_session_item_id)
            child_item_id = str(target.session_item_id)
            old, new = before_items[parent_id], after_items[child_item_id]
            old_identity = str(old.source_corpus_item_id or old.corpus_item_id)
            new_identity = str(new.source_corpus_item_id or new.corpus_item_id)
            if (parent_id in seen_parents or old_identity == "None" or old_identity != new_identity
                    or before_targets[parent_id].role != target.role
                    or language_identity(old.model_dump()) != language_identity(new.model_dump())):
                raise ValueError
            seen_parents.add(parent_id)
            items.append(PracticeComparisonItem(
                session_item_id=target.session_item_id, parent_session_item_id=target.parent_session_item_id,
                text=new.text, role=target.role,
                before=PracticeUseSummary.model_validate(before_results[parent_id].model_dump()),
                after=PracticeUseSummary.model_validate(after_results[child_item_id].model_dump()),
            ))
        if len(items) != len(before_items):
            raise ValueError
    except (KeyError, ValueError, ValidationError):
        response.status, response.reason = "incompatible", "The frozen language or target roles do not match."
        return response
    response.status = "ready"
    response.reason = ("These are observations from two conversations with different settings or roles. "
                       "Support and opportunity differences matter; no learning-gain score is inferred.")
    response.items = items
    return response
