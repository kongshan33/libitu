"""Bounded, owner-scoped projections of existing reports; never enqueue work."""

from copy import deepcopy

from fastapi import HTTPException

from app.integrations.speaking_feedback_repository import (
    InlineFeedbackStore, SupabaseFeedbackStore, get_feedback_store,
)

HISTORY_LIMIT = 100
_ITEM_FIELDS = ("id", "source_corpus_item_id", "kind", "text", "meaning", "slots")
_RESULT_FIELDS = ("session_item_id", "status", "role", "opportunity_status", "excluded_reason",
                  "independent_uses", "qualifying_independent_evidence")
_MESSAGE_FIELDS = ("id", "role", "status", "revision", "text", "ordinal",
                   "created_at", "started_at", "finalized_at")


def _select(row: dict, fields) -> dict:
    return {key: deepcopy(row[key]) for key in fields if key in row}


def project_report(job: dict, corpus_ids: set[str]) -> dict:
    """Mirror the SQL projection without returning other language or private state."""
    source = job.get("source") or {}
    session = source.get("session") or {}
    targets = (session.get("mission_plan") or {}).get("targets", [])
    results = (job.get("result") or {}).get("item_results", [])
    projected = []
    for item in session.get("items", []):
        if item.get("source_corpus_item_id") not in corpus_ids:
            continue
        result = next((row for row in results if row.get("session_item_id") == item.get("id")), {})
        refs = result.get("qualifying_independent_evidence") or []
        message_ids = {row.get("message_id") for row in refs if isinstance(row, dict)}
        projected.append({
            "item": _select(item, _ITEM_FIELDS),
            "target_role": next((row.get("role") for row in targets
                                 if row.get("session_item_id") == item.get("id")), None),
            "skipped": (source.get("target_states", {}).get(item.get("id")) or {}).get("skipped", False),
            "result": _select(result, _RESULT_FIELDS),
            # Keep all revisions of referenced messages so stale final text cannot win.
            "messages": [_select(row, _MESSAGE_FIELDS) for row in source.get("messages", [])
                         if row.get("id") in message_ids],
        })
    return {
        **_select(job, ("id", "session_id", "status", "rubric_version", "analysis_version")),
        "evidence_contract_version": session.get("evidence_contract_version"),
        "root_session_id": (session.get("practice") or {}).get("root_session_id") or job["session_id"],
        "scene": _select(session.get("mission_plan") or {}, ("setting", "goal", "user_role", "ai_role")),
        "items": projected,
    }


def read_support_history(owner: str, corpus_ids: list[str]) -> dict:
    adapter = get_feedback_store()
    if isinstance(adapter, SupabaseFeedbackStore):
        value = adapter._rpc("read_speaking_support_history", {
            "p_user_id": owner, "p_corpus_item_ids": corpus_ids, "p_limit": HISTORY_LIMIT,
        })
        if (not isinstance(value, dict) or not isinstance(value.get("reports"), list)
                or len(value["reports"]) > HISTORY_LIMIT or type(value.get("has_more")) is not bool):
            raise HTTPException(503, "Practice history is temporarily unavailable. Please retry.")
        return value
    if not isinstance(adapter, InlineFeedbackStore):
        raise HTTPException(503, "Practice history is temporarily unavailable. Please retry.")
    wanted = set(corpus_ids)
    with adapter._lock:
        # Unlike queue reads this does not prune or mutate even stale fixture jobs.
        jobs = [job for job in adapter._jobs.values()
                if job["user_id"] == owner and adapter._live(job)
                and any(item.get("source_corpus_item_id") in wanted
                        for item in (job.get("source") or {}).get("session", {}).get("items", []))]
        jobs.sort(key=lambda row: (row["created_at"], row["id"]), reverse=True)
        return {"reports": [project_report(job, wanted) for job in jobs[:HISTORY_LIMIT]],
                "has_more": len(jobs) > HISTORY_LIMIT}
