import asyncio
from copy import deepcopy
import json

import pytest

from app.schemas.speaking_feedback import FeedbackResult
from app.services import speaking_assessment as assessment
from app.services import speaking_missed_opportunities as missed
from test_speaking_assessment import ITEM, message, model, offered_attempt, planned_source, reference, scores, transport


def fixture():
    data = planned_source("The other team needs two days to finish their review.")
    data["session"]["items"][0]["text"] = "to be fair"
    data["session"]["support_level"] = "no_hint"
    data["session"]["evidence_contract_version"] = "speaking-evidence-v3"
    question = "Why is the other team's concern reasonable?"
    data["messages"].insert(0, message(
        question, "assistant-1", role="assistant", ordinal=0, response_id="response",
        created_at="2026-09-30T23:59:58Z",
    ))
    data["teaching_attempts"] = [offered_attempt(
        presented_at="2026-09-30T23:59:59Z",
        assessment={"outcome": "reflected", "exact_quote": question},
    )]
    proposal = {
        "session_item_id": ITEM, "opportunity_attempt_id": "attempt", "opportunity_response_id": "response",
        "original": reference(data["messages"][1]),
        "suggested": "To be fair, the other team needs two days to finish their review.",
        "reason": "Acknowledge their reasonable constraint using your own stated reason.",
    }
    output = model(data, quote=None)
    output["missed_opportunities"] = [proposal]
    return data, output


def compile_fixture(data, output, **kwargs):
    return assessment.compile_assessment(data, output, **kwargs)


def test_verified_suggestion_is_separate_from_usage_scores_and_statistics_and_stable():
    data, output = fixture()
    before = deepcopy(data), deepcopy(output)
    status, result = compile_fixture(data, output)
    baseline = compile_fixture(data, {**output, "missed_opportunities": []})[1]
    assert status == "ready" and result.missed_opportunities_status == "ready"
    assert len(result.missed_opportunities) == 1
    suggestion = result.missed_opportunities[0]
    assert suggestion.basis == "ai_suggestion"
    assert suggestion.original == assessment.validate_reference(output["missed_opportunities"][0]["original"], data["messages"])
    assert suggestion.opportunity_attempt_id == "attempt"
    assert result.statistics == baseline.statistics
    assert result.item_results == baseline.item_results
    assert scores(result) == scores(baseline) and scores(result)["transfer"] == 0
    assert not result.item_results[0].evidence
    assert not result.item_results[0].qualifying_independent_evidence
    assert suggestion.id == compile_fixture(data, output)[1].missed_opportunities[0].id
    output["missed_opportunities"][0]["suggested"] += "!"
    assert suggestion.id != compile_fixture(data, output)[1].missed_opportunities[0].id
    assert data == before[0]


@pytest.mark.parametrize("change", [
    "opportunity_role", "skipped", "unpresented", "not_reflected", "unsent", "missing_assistant",
    "interrupted", "playback_pending", "late_receipt", "missing_receipt_time", "missing_user_clock",
    "invalid_user_clock", "naive_user_clock", "no_followup", "unavailable_first_user", "intervening_assistant",
    "missing_opportunity_quote", "fabricated_opportunity_quote",
])
def test_no_missed_label_without_a_confirmed_prior_opportunity_and_its_actual_reply(change):
    data, output = fixture()
    attempt, reply = data["teaching_attempts"][0], data["messages"][1]
    if change == "opportunity_role":
        data["session"]["mission_plan"]["targets"][0]["role"] = "opportunity"
    elif change == "skipped":
        data["target_states"] = {ITEM: {"skipped": True}}
    elif change == "unpresented":
        attempt["presented"] = False
    elif change == "not_reflected":
        attempt["assessment"]["outcome"] = "not_reflected"
    elif change == "unsent":
        attempt["send_status"] = "failed"
    elif change == "missing_assistant":
        data["messages"].pop(0)
    elif change == "interrupted":
        data["messages"][0]["status"] = "interrupted"
    elif change == "playback_pending":
        data["messages"][0]["playback_pending"] = True
    elif change == "late_receipt":
        attempt["presented_at"] = "2026-10-01T00:00:01Z"
    elif change == "missing_receipt_time":
        attempt.pop("presented_at")
    elif change in {"missing_user_clock", "invalid_user_clock", "naive_user_clock"}:
        reply["created_at"] = {"missing_user_clock": None, "invalid_user_clock": "bad", "naive_user_clock": "2026-10-01T00:00:00"}[change]
    elif change == "no_followup":
        data["messages"].pop()
    elif change == "unavailable_first_user":
        reply["status"] = "unavailable"
        data["messages"].append(message("The later explanation is about a different point.", "later", ordinal=3))
    elif change == "intervening_assistant":
        reply["ordinal"] = 3
        data["messages"].insert(1, message("Let us change topic.", "other-ai", role="assistant", ordinal=2))
    elif change == "missing_opportunity_quote":
        attempt["assessment"].pop("exact_quote")
    else:
        attempt["assessment"]["exact_quote"] = "Invented opportunity"
    _, result = compile_fixture(data, output)
    assert result.missed_opportunities == []
    assert result.missed_opportunities_status == "not_applicable"


@pytest.mark.parametrize("change", ["wrong_target", "wrong_attempt", "wrong_response", "assistant_quote",
                                   "stale_revision", "invented_quote", "wrong_offset", "ambiguous_quote"])
def test_suggestion_reference_requires_selected_target_exact_opportunity_and_final_user_span(change):
    data, output = fixture()
    row = output["missed_opportunities"][0]
    if change in {"wrong_target", "wrong_attempt", "wrong_response"}:
        key = {"wrong_target": "session_item_id", "wrong_attempt": "opportunity_attempt_id",
               "wrong_response": "opportunity_response_id"}[change]
        row[key] = "not-in-source"
    elif change == "assistant_quote":
        row["original"] = reference(data["messages"][0])
    elif change == "stale_revision":
        row["original"]["transcript_revision"] = 2
    elif change == "invented_quote":
        row["original"]["quote"] = "My team can finish today."
    elif change == "wrong_offset":
        row["original"]["start"] = 1
    else:
        data["messages"][1]["text"] += " " + data["messages"][1]["text"]
        row["original"].pop("start")
        row["original"].pop("end")
    _, result = compile_fixture(data, output)
    assert result.missed_opportunities == []
    assert result.missed_opportunities_status == "unavailable"


def test_unique_unicode_quote_uses_server_utf16_offsets():
    data, output = fixture()
    original = data["messages"][1]
    original["text"] = "  🙂 " + original["text"] + "  "
    proposal = output["missed_opportunities"][0]
    proposal["original"]["quote"] = original["text"].strip()
    proposal["original"].pop("start")
    proposal["original"].pop("end")
    result = compile_fixture(data, output)[1]
    assert result.missed_opportunities[0].original.start == 2
    assert result.missed_opportunities[0].original.end == len(original["text"].rstrip().encode("utf-16-le")) // 2


@pytest.mark.parametrize("text,quote", [
    ("I do not think testing takes time.", "testing takes time."),
    ("I will not promise that testing takes time.", "testing takes time."),
    ("If the service is down, testing takes time.", "testing takes time."),
])
def test_full_user_turn_required_so_substring_cannot_drop_negation_commitment_or_condition(text, quote):
    data, output = fixture()
    reply = data["messages"][1]
    reply["text"] = text
    proposal = output["missed_opportunities"][0]
    proposal["original"] = reference(reply, quote=quote)
    proposal["suggested"] = "To be fair, " + quote
    output = {**model(data, quote=None), "missed_opportunities": [proposal]}
    status, result = compile_fixture(data, output)
    baseline_status = compile_fixture(data, {**output, "missed_opportunities": []})[0]
    assert status == baseline_status and result.missed_opportunities_status == "unavailable"
    assert not result.missed_opportunities


def test_model_explicit_abstention_is_distinct_from_rejected_suggestions():
    data, output = fixture()
    output["missed_opportunities"] = []
    result = compile_fixture(data, output)[1]
    assert result.missed_opportunities_status == "ready"
    assert not result.missed_opportunities


@pytest.mark.parametrize("raw", [None, "wrong shape", {}, [None], [{"unknown": True}], [0, 1, 2, 3]])
def test_bad_optional_branch_preserves_ready_scores_and_valid_base_report(raw):
    data, output = fixture()
    expected = compile_fixture(data, output)[1]
    output["missed_opportunities"] = raw
    status, result = compile_fixture(data, output)
    assert status == "ready" and result.missed_opportunities_status == "unavailable"
    assert result.missed_opportunities == []
    assert result.dimensions == expected.dimensions
    assert result.statistics == expected.statistics
    assert result.item_results == expected.item_results


def test_valid_suggestion_survives_another_malformed_candidate_and_target_duplicates():
    data, output = fixture()
    output["missed_opportunities"].extend([None, deepcopy(output["missed_opportunities"][0])])
    result = compile_fixture(data, output)[1]
    assert result.missed_opportunities_status == "ready"
    assert len(result.missed_opportunities) == 1


def test_unreviewed_conversation_does_not_claim_missed_opportunities():
    data, output = fixture()
    output["reviewed_message_ids"] = []
    result = compile_fixture(data, output)[1]
    assert result.missed_opportunities_status == "unavailable"
    assert not result.missed_opportunities


@pytest.mark.parametrize("verdict", ["appropriate", "uncertain"])
def test_confirmed_or_uncertain_target_use_does_not_get_a_missed_label(verdict):
    data, output = fixture()
    data["messages"][1]["text"] = "To be fair, the other team needs two days to finish their review."
    output = model(data, quote="To be fair", verdict=verdict)
    output["missed_opportunities"] = fixture()[1]["missed_opportunities"]
    result = compile_fixture(data, output)[1]
    assert result.missed_opportunities_status == "not_applicable" and not result.missed_opportunities


@pytest.mark.parametrize("original,suggested,target,kind,accepted", [
    ("The team needs time.", "To be fair, the team needs time.", "to be fair", "chunk", True),
    ("We should wait.", "To be fair, we should wait.", "to be fair", "chunk", True),
    ("Testing takes time.", "The way I see it, testing takes time.", "The way I see it…", "chunk", True),
    ("I should not promise it.", "The way I see it, I should not promise it.", "The way I see it…", "chunk", True),
    ("I should not promise it.", "The way I see it, I should promise it.", "The way I see it…", "chunk", False),
    ("I could test it.", "The way I see it, I will test it.", "The way I see it…", "chunk", False),
    ("Testing takes time.", "The way I see it, I promise testing takes time.", "The way I see it…", "chunk", False),
    ("I see it.", "The way I see it.", "The way I see it…", "chunk", False),
    ("Testing takes time.", "The way I see it, it takes time.", "The way I see it…", "chunk", False),
    ("Testing takes time.", "I think testing takes time.", "I think", "chunk", False),
    ("The deadline is Friday, we should test today.", "Given the deadline is Friday, we should test today.",
     "Given [premise], we should [action]", "structure", True),
    ("The team needs two days.", "To be fair, the team needs three days.", "to be fair", "chunk", False),
    ("The team needs 2 days.", "To be fair, the team needs 3 days.", "to be fair", "chunk", False),
    ("Alex needs time.", "To be fair, Jordan needs time.", "to be fair", "chunk", False),
    ("Alex helps Jordan.", "To be fair, Jordan helps Alex.", "to be fair", "chunk", False),
    ("We could wait.", "To be fair, we will wait.", "to be fair", "chunk", False),
    ("We will not wait.", "To be fair, we will wait.", "to be fair", "chunk", False),
    ("We need time.", "To be fair, they need time.", "to be fair", "chunk", False),
    ("We need time.", "To be fair, we need time because Alex is sick.", "to be fair", "chunk", False),
    ("I will wait.", "I promise I will wait.", "I promise", "chunk", False),
    ("We should test today.", "Given the new deadline, we should test today.",
     "Given [premise], we should [action]", "structure", False),
    ("The deadline is Friday.", "Given the deadline is Friday, we should delay.",
     "Given [premise], we should [action]", "structure", False),
    ("We should test today.", "Given [premise], we should test today.",
     "Given [premise], we should [action]", "structure", False),
    ("The team needs time.", "To be fair, the team needs time; to be fair, yes.", "to be fair", "chunk", False),
])
def test_content_guard_allows_target_framing_but_rejects_changed_facts_roles_and_commitments(
        original, suggested, target, kind, accepted):
    assert missed.preserves_content(original, suggested, target, kind) is accepted


@pytest.mark.parametrize("before,after", [
    ("-5", "5"), ("5%", "5"), ("1/5", "1.5"), ("$5", "€5"), ("10-15", "10.15"),
    ("−5", "+5"), ("(5)", "5"), ("1e-3", "1e3"), ("10:15", "10.15"),
    ("5‰", "5%"), ("₹5", "¥5"), ("5 €", "5 $"), ("2 + 3", "2 - 3"),
    ("±5", "5"), ("~5", "5"), ("≥5", "≤5"),
])
def test_numeric_literals_preserve_sign_currency_percent_ratio_range_and_exponent(before, after):
    assert not missed.preserves_content(
        f"The value is {before}.", f"To be fair, the value is {after}.", "to be fair", "chunk",
    )


@pytest.mark.parametrize("number", ["-5", "5%", "1/5", "$5", "10-15", "−5", "(5)", "1e-3", "₹ 5", "5 €"])
def test_unchanged_numeric_literals_allow_safe_frame_insertion(number):
    assert missed.preserves_content(
        f"The value is {number}.", f"To be fair, the value is {number}.", "to be fair", "chunk",
    )


def test_numeric_changes_are_not_exempted_by_target_frame():
    assert not missed.preserves_content(
        "The value is 5.", "A 5% change means the value is 5.", "A 5% change means", "chunk",
    )


@pytest.mark.parametrize("version", ["speaking-feedback-v1", "speaking-feedback-v2"])
def test_legacy_jobs_skip_p3_and_do_not_emit_new_positive_evidence(version):
    data, output = fixture()
    result = compile_fixture(data, output, analysis_version=version)[1]
    assert result.missed_opportunities_status == "not_requested"
    assert result.missed_opportunities == []
    assert result.item_results[0].qualifying_independent_evidence == []
    context = assessment._context(data)
    assert "missed_opportunity_candidates" not in context
    assert "missed_opportunities" not in context["output_schema"]["properties"]


def test_v3_context_only_exposes_eligible_grounded_candidates_and_typed_optional_schema():
    data, _ = fixture()
    context = assessment._context(data, include_missed=True)
    row = context["missed_opportunity_candidates"][0]
    assert row["user_message_id"] == "user-1"
    assert row["user_text"] == data["messages"][1]["text"]
    assert row["opportunity_attempt_id"] == "attempt"
    schema = context["output_schema"]["properties"]["missed_opportunities"]
    assert schema["maxItems"] == 3
    assert schema["items"]["properties"]["original"] == {"$ref": "#/$defs/_Reference"}
    assert "user_id" not in json.dumps(context)


def test_v3_uses_one_provider_call_and_bad_suggestions_do_not_discard_its_scores(monkeypatch):
    data, output = fixture()
    output["missed_opportunities"] = "malformed optional output"
    requests = []
    def handler(request):
        import httpx
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}]})
    transport(monkeypatch, handler)
    status, result = asyncio.run(assessment.assess_feedback(data))
    assert len(requests) == 1 and status == "ready"
    assert result.missed_opportunities_status == "unavailable"
    assert scores(result)["task_fit"] == 75
    assert "NEVER evidence of user" in requests[0]["messages"][0]["content"]


def test_old_result_schema_loads_without_invented_suggestions_or_positive_evidence():
    data, output = fixture()
    old = compile_fixture(data, output, analysis_version="speaking-feedback-v2")[1].model_dump()
    old.pop("missed_opportunities")
    old.pop("missed_opportunities_status")
    for item in old["item_results"]:
        item.pop("qualifying_independent_evidence")
    parsed = FeedbackResult.model_validate(old)
    assert parsed.missed_opportunities_status == "not_requested"
    assert not parsed.missed_opportunities and not parsed.item_results[0].qualifying_independent_evidence
