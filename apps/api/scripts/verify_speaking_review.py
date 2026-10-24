"""Opt-in, single-call feedback-v3 probe using an in-process synthetic source.

No database or Mission API is used. The opportunity and playback receipt are
fixtures, not Gemini/audio evidence. No learner data, model prompt, provider
output or credential is logged. This is an integration probe, not a learning
effect or model-accuracy evaluation.
"""
from __future__ import annotations

import argparse
import asyncio
from copy import deepcopy
import json
import logging
import os
from pathlib import Path
import re
import sys
from time import monotonic

_API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_API_ROOT))

import httpx
from pydantic import ValidationError

from app.schemas.speaking import EVIDENCE_CONTRACT_VERSION
from app.schemas.speaking_feedback import ANALYSIS_VERSION, RUBRIC_VERSION
from app.services import speaking_assessment as assessment
from app.services import speaking_missed_opportunities as missed

ITEM = "a0000000-0000-4000-8000-000000000001"
CORPUS = "a0000000-0000-4000-8000-000000000002"


def synthetic_source() -> dict:
    question = "Why is the other team's concern reasonable?"
    return {
        "session": {
            "id": "a0000000-0000-4000-8000-000000000003",
            "client_id": "a0000000-0000-4000-8000-000000000004",
            "user_id": "synthetic-review-probe",
            "scenario_type": "workplace", "goal": "Discuss a reasonable review deadline.",
            "difficulty": "standard", "feedback_level": "balanced", "logic_template": None,
            "status": "completed", "created_at": "2026-10-20T00:00:00Z", "turn_count": 1,
            "support_level": "no_hint", "evidence_contract_version": EVIDENCE_CONTRACT_VERSION,
            "items": [{
                "id": ITEM, "corpus_item_id": CORPUS, "source_corpus_item_id": CORPUS,
                "ordinal": 0, "kind": "chunk", "text": "to be fair",
                "meaning": "Acknowledge a reasonable point.",
                "usage_note": "Recognize the validity of another person's concern.",
                "register": "professional",
            }],
            "mission_plan": {
                "plan_id": "a0000000-0000-4000-8000-000000000005",
                "candidate_id": "a0000000-0000-4000-8000-000000000006", "version": 1,
                "scenario_type": "workplace", "title": "Review deadline discussion",
                "setting": "A planning meeting about the other team's review deadline.",
                "goal": "Discuss a reasonable review deadline.",
                "user_role": "Project engineer", "ai_role": "Team lead", "register": "professional",
                "targets": [{
                    "session_item_id": ITEM, "corpus_item_id": CORPUS, "role": "primary",
                    "communicative_function": "Acknowledge a reasonable concern",
                    "fit": "high", "fit_reason": "The discussion asks for a fair assessment of their constraint.",
                    "trigger_question": question, "skip_when": "There is no differing concern to acknowledge.",
                    "sentence_frame": "To be fair, [reasonable point].", "metadata_status": "available",
                }],
            },
        },
        "messages": [
            {
                "id": "synthetic-assistant", "role": "assistant", "text": question,
                "revision": 1, "ordinal": 0, "status": "final", "response_id": "synthetic-response",
                "input_source": "text", "created_at": "2026-10-20T00:00:01Z",
            },
            {
                "id": "synthetic-user", "role": "user",
                "text": "The other team needs two days to finish their review.",
                "revision": 1, "ordinal": 1, "status": "final", "input_source": "text",
                "created_at": "2026-10-20T00:00:03Z",
            },
        ],
        "support": {"level": "no_hint", "version": 0},
        "evidence": [], "controller": {"exposures": []}, "target_states": {},
        "teaching_attempts": [{
            "id": "synthetic-attempt", "send_status": "sent", "response_id": "synthetic-response",
            "sent_at": "2026-10-20T00:00:00Z", "bound_at": "2026-10-20T00:00:01Z",
            "presented": True, "presented_at": "2026-10-20T00:00:02Z",
            "policy": {"target_item_id": ITEM, "action": "implicit_elicitation",
                       "support_level": "no_hint", "support_version": 0},
            "assessment": {"outcome": "reflected", "exact_quote": question},
        }],
    }


def _synthetic_validation_checks(model) -> dict:
    """Diagnose only fixed validation predicates against this script's fixture."""
    source = synthetic_source()
    session, _, reliable = assessment._source(source)
    candidates = {(row["session_item_id"], row["opportunity_attempt_id"], row["opportunity_response_id"]): row
                  for row in missed.opportunity_candidates(source, session, reliable)}
    dimensions = {dimension.id: dimension for dimension in model.dimensions}
    checks = {
        "reviewed_all_users": (set(model.reviewed_message_ids) == {row["id"] for row in reliable}
                               and len(model.reviewed_message_ids) == len(reliable)),
        "dimension_ids_exact": (set(dimensions) == set(assessment.CRITERIA)
                                and len(dimensions) == len(model.dimensions)),
        "criterion_ids_exact": all(
            dimension.id in assessment.CRITERIA
            and {row.id for row in dimension.criteria} == {row[0] for row in assessment.CRITERIA[dimension.id]}
            and len(dimension.criteria) == len(assessment.CRITERIA[dimension.id])
            for dimension in model.dimensions
        ),
        "rating_references_valid": all(
            bool(criterion.evidence)
            and all(assessment.validate_reference(ref, reliable) is not None for ref in criterion.evidence)
            for dimension in model.dimensions for criterion in dimension.criteria if criterion.rating is not None
        ),
        "item_ids_exact": (len(model.item_results) == len(session.items)
                           and {row.session_item_id for row in model.item_results} == {str(item.id) for item in session.items}),
        "suggestions_list": isinstance(model.missed_opportunities, list),
        "suggestions": [],
    }
    if not isinstance(model.missed_opportunities, list):
        return checks
    checks["suggestion_count"] = len(model.missed_opportunities)
    for raw in model.missed_opportunities[:missed.MAX_SUGGESTIONS]:
        try:
            proposal = missed.MissedProposal.model_validate(raw)
        except ValidationError:
            checks["suggestions"].append({"schema_valid": False})
            continue
        candidate = candidates.get((proposal.session_item_id, proposal.opportunity_attempt_id,
                                    proposal.opportunity_response_id))
        reference = assessment.validate_reference(proposal.original, reliable)
        checks["suggestions"].append({
            "schema_valid": True, "candidate_match": candidate is not None,
            "reference_valid": reference is not None,
            "full_user_quote": bool(candidate and reference
                                    and reference.message_id == candidate["user_message_id"]
                                    and reference.transcript_revision == candidate["transcript_revision"]
                                    and reference.quote.strip() == candidate["user_text"].strip()),
            "content_preserved": bool(candidate and reference and missed.preserves_content(
                reference.quote, proposal.suggested, candidate["target_text"], candidate["target_kind"])),
        })
    return checks


async def _capture_decoded(iterator, trace):
    """Capture bounded decoded bytes, after HTTPX handles content encoding."""
    captured = bytearray()
    async for chunk in iterator:
        if len(captured) + len(chunk) <= assessment.MAX_RESPONSE_BYTES:
            captured.extend(chunk)
        else:
            trace["response_limit"] = True
        yield chunk
    if trace.get("response_limit"):
        return
    try:
        envelope = json.loads(captured)
        raw_usage = envelope.get("usage", {})
        if isinstance(raw_usage, dict):
            trace["usage"] = {
                key: value for key, value in raw_usage.items()
                if key in {"prompt_tokens", "completion_tokens", "total_tokens",
                           "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"}
                and type(value) is int and value >= 0
            }
        choice = envelope["choices"][0]
        finish = choice.get("finish_reason")
        trace["finish_reason"] = finish if finish in {"stop", "length", "content_filter"} else "other"
        try:
            raw_assessment = json.loads(choice["message"]["content"])
            dimensions = raw_assessment.get("dimensions") if isinstance(raw_assessment, dict) else None
            trace["canonicalized_empty_notes"] = sum(
                isinstance(row, dict) and "criteria_note" in row and row["criteria_note"] is None
                for row in dimensions
            ) if isinstance(dimensions, list) else 0
            parsed = assessment._parse_assessment(choice["message"]["content"], include_missed=True)
        except ValidationError as error:
            # Only fixed validator codes and known field names; no inputs,
            # messages or arbitrary extra-key names from the model are retained.
            fields = {"reviewed_message_ids", "dimensions", "criteria", "id", "rating", "reason",
                      "summary", "evidence", "item_results", "session_item_id", "uses", "reference",
                      "match_type", "appropriateness", "message_id", "transcript_revision",
                      "quote", "start", "end", "logic_stages", "label", "status", "refactors",
                      "original", "suggested", "save_text", "save_kind", "save_meaning", "missed_opportunities",
                      "score", "basis", "dimension", "name"}
            diagnostics = [
                {"type": row["type"], "loc": [
                    part if isinstance(part, int) or part in fields else "unknown_field" for part in row["loc"]
                ]} for row in error.errors(include_input=False, include_context=False, include_url=False)[:12]
            ]
            if trace.get("diagnose_extra_keys") is True:
                # Explicitly opted-in synthetic probe only: retain bounded field
                # names, never provider values, exception messages or raw JSON.
                rows = error.errors(include_input=True, include_context=False, include_url=False)[:12]
                for diagnostic, row in zip(diagnostics, rows, strict=True):
                    key = row["loc"][-1] if row["loc"] else None
                    if (row["type"] == "extra_forbidden" and isinstance(key, str)
                            and len(key) <= 40 and re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*", key)):
                        diagnostic["extra_field"] = key
                        diagnostic["extra_field_type"] = type(row["input"]).__name__
            trace["assessment_schema_errors"] = diagnostics
        else:
            trace["assessment_schema_valid"] = True
            if trace.get("diagnose_extra_keys") is True:
                trace["validation_checks"] = _synthetic_validation_checks(parsed)
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        trace["envelope_metadata"] = "unavailable"


class _TraceTransport(httpx.AsyncBaseTransport):
    def __init__(self, inner, trace):
        self.inner, self.trace = inner, trace

    async def handle_async_request(self, request):
        self.trace["request_count"] += 1
        if self.trace["request_count"] > 1:
            raise ValueError("probe_request_budget")
        response = await self.inner.handle_async_request(request)
        self.trace["http_status"] = response.status_code
        return response

    async def aclose(self):
        await self.inner.aclose()


async def run_probe(*, ipv4: bool = False, diagnose_extra_keys: bool = False) -> dict:
    source = synthetic_source()
    before = deepcopy(source)
    context = assessment._context(source, include_missed=True)
    if len(context["missed_opportunity_candidates"]) != 1:
        raise ValueError("probe_fixture_not_eligible")
    trace = {"request_count": 0}
    if diagnose_extra_keys:
        trace["diagnose_extra_keys"] = True
    original_client = assessment.httpx.AsyncClient

    class ObservedClient(original_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = _TraceTransport(
                httpx.AsyncHTTPTransport(retries=0, local_address="0.0.0.0" if ipv4 else None), trace,
            )
            super().__init__(*args, **kwargs)

        async def send(self, *args, **kwargs):
            response = await super().send(*args, **kwargs)
            original_iterator = response.aiter_bytes

            def traced_bytes(*iter_args, **iter_kwargs):
                return _capture_decoded(original_iterator(*iter_args, **iter_kwargs), trace)

            response.aiter_bytes = traced_bytes
            return response

    started = monotonic()
    assessment.httpx.AsyncClient = ObservedClient
    try:
        async with asyncio.timeout(45):
            status, result = await assessment.assess_feedback(source, analysis_version=ANALYSIS_VERSION)
    finally:
        assessment.httpx.AsyncClient = original_client
        trace["elapsed_ms"] = round((monotonic() - started) * 1000, 2)
    if before != source:
        raise ValueError("probe_source_mutated")
    if result.statistics.used_primary_targets or any(
            item.qualifying_independent_evidence for item in result.item_results):
        raise ValueError("probe_suggestion_counted_as_usage")
    return {
        "fixture": "synthetic_review_deadline", "synthetic": True, "database_calls": 0,
        "rubric_version": RUBRIC_VERSION, "analysis_version": ANALYSIS_VERSION,
        "evidence_contract_version": EVIDENCE_CONTRACT_VERSION,
        "provider": trace, "status": status,
        "missed_opportunities_status": result.missed_opportunities_status,
        "missed_opportunities_count": len(result.missed_opportunities),
        "assessed_user_turns": result.statistics.assessed_turns,
        "used_primary_targets": result.statistics.used_primary_targets,
        "item_statuses": [item.status for item in result.item_results],
        "provider_assessment_rejected": assessment.PROVIDER_UNAVAILABLE_NOTICE in result.notices,
        "source_unchanged": before == source,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-live", action="store_true", help="Authorize exactly one real Doubao request.")
    parser.add_argument("--ipv4", action="store_true")
    parser.add_argument("--diagnose-extra-keys", action="store_true",
                        help="For this synthetic source only, report extra snake_case key names of at most 40 characters.")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.run_live:
        parser.error("--run-live is required; this probe incurs one model request.")
    output = args.output.resolve() if args.output else None
    os.chdir(_API_ROOT)
    logging.disable(logging.CRITICAL)
    try:
        event = asyncio.run(run_probe(ipv4=args.ipv4, diagnose_extra_keys=args.diagnose_extra_keys))
    except Exception as error:
        # Never print exception messages: transport/provider exceptions can
        # contain a URL or data. The fixed type is sufficient for diagnosis.
        event = {"synthetic": True, "outcome": "probe_error", "error_type": type(error).__name__}
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(event, ensure_ascii=False))
    return 1 if event.get("outcome") == "probe_error" else 0


if __name__ == "__main__":
    raise SystemExit(main())
