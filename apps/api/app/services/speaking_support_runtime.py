"""CAS-safe support changes and public, evidence-anchored demonstration spans."""
from __future__ import annotations

from copy import deepcopy

from app.services.speaking_support import effective_support
from app.services.speaking_teaching import find_target_quote, _utf16_length


class SupportConflict(ValueError):
    """The learner's support selector was based on an obsolete snapshot."""


def change_support(session, document: dict, level: str, expected_version: int, at: str) -> None:
    current = effective_support(session, document)
    if (current or {}).get("version", 0) != expected_version:
        raise SupportConflict
    if current and current["level"] == level:
        return
    support = {"level": level, "version": expected_version + 1}
    document["support"] = support
    history = document.setdefault("support_history", [])
    history.append({**support, "at": at})
    del history[:-100]
    policy = document.get("policy") or {}
    if policy.get("status") == "pending":
        policy.update(status="expired", expiry_reason="support_changed")
    # Previously exposed help remains in the assistance ledger. Removing the card
    # only controls the next display, never the provenance of learner utterances.
    document["help"] = None
    document["hint"] = None


def support_workspace(session, document: dict) -> dict:
    support = effective_support(session, document)
    spans = []
    if support is None or support["level"] == "no_hint":
        return {"support": support, "demonstrations": spans}
    items = {str(item.id): item for item in session.items}
    seen = set()
    for attempt in document.get("teaching_attempts", []):
        policy = attempt.get("policy") or {}
        assessment = attempt.get("assessment") or {}
        item = items.get(policy.get("target_item_id"))
        if (policy.get("action") != "model_then_transfer" or item is None
                or assessment.get("outcome") != "reflected" or not attempt.get("presented")):
            continue
        message = next((row for row in document.get("messages", [])
                        if row.get("response_id") == attempt.get("response_id")
                        and row.get("role") == "assistant" and row.get("status") == "final"), None)
        model_quote = assessment.get("model_quote")
        if (not message or not isinstance(model_quote, str) or not model_quote
                or message["text"].count(model_quote) != 1):
            continue
        match = find_target_quote(model_quote, item.text, item.kind)
        if match is None or model_quote.count(match[0]) != 1:
            continue
        quote = match[0]
        start = message["text"].index(model_quote) + model_quote.index(quote)
        key = (message["id"], message["revision"], str(item.id))
        if key in seen:
            continue
        seen.add(key)
        spans.append({"target_item_id": str(item.id), "message_id": message["id"],
                      "revision": message["revision"], "start": _utf16_length(message["text"][:start]),
                      "end": _utf16_length(message["text"][:start + len(quote)]), "quote": quote})
    return {"support": deepcopy(support), "demonstrations": spans}
