"""Pure projections for frozen mission targets and their recorded opportunities."""
from __future__ import annotations

from copy import deepcopy


def planned_targets(session) -> dict[str, dict]:
    plan = getattr(session, "mission_plan", None)
    if hasattr(plan, "model_dump"):
        plan = plan.model_dump(mode="json")
    if not isinstance(plan, dict):
        return {}
    by_corpus = {str(item.corpus_item_id): str(item.id) for item in session.items if item.corpus_item_id}
    item_ids = {str(item.id) for item in session.items}
    result = {}
    for target in plan.get("targets", []):
        if not isinstance(target, dict):
            continue
        target_id = str(target.get("session_item_id") or by_corpus.get(str(target.get("corpus_item_id")), ""))
        if target_id in item_ids:
            result[target_id] = deepcopy(target)
    return result


def target_is_skipped(document: dict, target_id: str | None) -> bool:
    return (document.get("target_states", {}).get(target_id) or {}).get("skipped") is True


def target_version(document: dict, target_id: str | None) -> int:
    return (document.get("target_states", {}).get(target_id) or {}).get("version", 0)


def set_target_skipped(document: dict, target_id: str, reason: str | None, now: str) -> None:
    """CAS-safe, idempotent state change; restoring never erases skip history."""
    states = document.setdefault("target_states", {})
    old = states.get(target_id, {})
    skipped = reason is not None
    if old.get("skipped", False) == skipped and (not skipped or old.get("reason") == reason):
        return
    history = deepcopy(old.get("history", []))
    history.append({"action": "skip" if skipped else "restore", "reason": reason, "at": now})
    states[target_id] = {
        "skipped": skipped, "reason": reason, "skipped_at": now if skipped else old.get("skipped_at"),
        "restored_at": old.get("restored_at") if skipped else now,
        "version": old.get("version", 0) + 1, "history": history,
    }
    policy = document.get("policy") or {}
    if policy.get("target_item_id") == target_id and policy.get("status") == "pending":
        policy.update(status="expired", expiry_reason="target_state_changed")
    if (document.get("help") or {}).get("target_item_id") == target_id:
        document["help"] = None
        document["hint"] = None


def opportunity_view(session, document: dict) -> list[dict]:
    """Sending, compliance and actual presentation remain separate facts."""
    targets = planned_targets(session)
    rows = []
    for item in session.items:
        target_id = str(item.id)
        target = targets.get(target_id)
        if target is None:
            continue  # Historical sessions retain their existing reporting contract.
        state = document.get("target_states", {}).get(target_id) or {}
        attempts = [row for row in document.get("teaching_attempts", [])
                    if (row.get("policy") or {}).get("target_item_id") == target_id]
        sent = any(row.get("send_status") == "sent" for row in attempts)
        bound = any(row.get("response_id") for row in attempts)
        reflected = any((row.get("assessment") or {}).get("outcome") == "reflected" for row in attempts)
        presented = any(row.get("presented") is True for row in attempts)
        offered = any((row.get("assessment") or {}).get("outcome") == "reflected"
                      and row.get("presented") is True for row in attempts)
        used = any(row.get("session_item_id") == target_id and row.get("appropriateness") == "appropriate"
                   for row in document.get("evidence", []))
        rows.append({
            "session_item_id": target_id, "role": target["role"],
            "status": "skipped" if state.get("skipped") else "used" if used else "offered" if offered else "planned",
            "skipped_reason": state.get("reason") if state.get("skipped") else None,
            "skipped_at": state.get("skipped_at"), "sent": sent, "bound": bound,
            "reflected": reflected, "presented": presented,
            "last_response_id": next((row["response_id"] for row in reversed(attempts) if row.get("response_id")), None),
        })
    return rows
