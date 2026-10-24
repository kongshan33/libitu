import asyncio
import gzip
import json
from types import SimpleNamespace

import httpx
import pytest

from scripts import verify_speaking_review as probe
from test_speaking_assessment import model, reference


@pytest.mark.parametrize("compressed", [False, True])
def test_probe_keeps_one_call_and_only_safe_provider_metadata(monkeypatch, compressed):
    data = probe.synthetic_source()
    output = model(data, quote=None)
    output["item_results"][0]["session_item_id"] = probe.ITEM
    output["missed_opportunities"] = [{
        "session_item_id": probe.ITEM,
        "opportunity_attempt_id": "synthetic-attempt",
        "opportunity_response_id": "synthetic-response",
        "original": reference(data["messages"][1]),
        "suggested": "To be fair, the other team needs two days to finish their review.",
        "reason": "Acknowledge their reasonable constraint.",
    }]
    requests = []

    def handler(request):
        requests.append(request)
        envelope = {
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 200, "total_tokens": 300,
                      "unknown": "must not be emitted"},
        }
        content = json.dumps(envelope).encode()
        return httpx.Response(200, stream=httpx.ByteStream(gzip.compress(content) if compressed else content),
                              headers={"Content-Encoding": "gzip"} if compressed else {})

    monkeypatch.setattr(probe.assessment, "get_settings", lambda: SimpleNamespace(
        ark_api_key="synthetic-secret", ark_base_url="https://fixture.invalid",
        ark_model="fixture-model",
    ))
    monkeypatch.setattr(probe.httpx, "AsyncHTTPTransport", lambda **kwargs: httpx.MockTransport(handler))
    event = asyncio.run(probe.run_probe())
    assert len(requests) == event["provider"]["request_count"] == 1
    assert event["provider"]["usage"] == {"prompt_tokens": 100, "completion_tokens": 200, "total_tokens": 300}
    assert event["status"] == "ready" and event["missed_opportunities_count"] == 1
    assert event["used_primary_targets"] == 0 and event["source_unchanged"]
    assert event["database_calls"] == 0
    assert event["provider"]["assessment_schema_valid"] is True
    logged = json.dumps(event)
    assert all(secret not in logged for secret in ["synthetic-secret", "must not be emitted", "The other team"])


def test_transport_refuses_second_network_attempt():
    calls = []
    inner = httpx.MockTransport(lambda request: (calls.append(request) or httpx.Response(200)))
    trace = {"request_count": 0}
    transport = probe._TraceTransport(inner, trace)

    async def requests():
        request = httpx.Request("POST", "https://fixture.invalid")
        await transport.handle_async_request(request)
        with pytest.raises(ValueError, match="probe_request_budget"):
            await transport.handle_async_request(request)
        await transport.aclose()

    asyncio.run(requests())
    assert len(calls) == 1


def test_schema_diagnostic_does_not_emit_extra_key_or_provider_text():
    trace = {}
    raw = {"choices": [{"finish_reason": "stop", "message": {
        "content": json.dumps({"provider text must remain private": "another private value"})
    }}]}

    async def read():
        async def chunks():
            yield json.dumps(raw).encode()
        async for _ in probe._capture_decoded(chunks(), trace):
            pass

    asyncio.run(read())
    assert trace["assessment_schema_errors"]
    assert "private" not in json.dumps(trace)


@pytest.mark.parametrize("field,visible", [
    ("synthetic_extra_field", True),
    ("field2", True),
    ("provider text must remain private", False),
    ("UPPER_CASE", False),
    ("a" * 41, False),
])
def test_opted_in_synthetic_diagnostic_emits_only_bounded_extra_key(field, visible):
    trace = {"diagnose_extra_keys": True}
    output = model(probe.synthetic_source(), quote=None)
    output["dimensions"][0][field] = "provider value must remain private"
    envelope = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}]}

    async def read():
        async def chunks():
            yield json.dumps(envelope).encode()
        async for _ in probe._capture_decoded(chunks(), trace):
            pass

    asyncio.run(read())
    assert (trace["assessment_schema_errors"][0].get("extra_field") == field) is visible
    assert "provider value" not in json.dumps(trace)
    if not visible:
        assert field not in json.dumps(trace)


@pytest.mark.parametrize("field", ["score", "rating", "label", "basis", "criteria_note"])
def test_extra_dimension_field_is_rejected_without_retry_or_relaxing_scores(monkeypatch, field):
    data = probe.synthetic_source()
    output = model(data, quote=None)
    output["item_results"][0]["session_item_id"] = probe.ITEM
    output["missed_opportunities"] = []
    for dimension in output["dimensions"]:
        dimension[field] = 3 if field in {"score", "rating"} else "unrequested"
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        envelope = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}]}
        return httpx.Response(200, stream=httpx.ByteStream(json.dumps(envelope).encode()))

    monkeypatch.setattr(probe.assessment, "get_settings", lambda: SimpleNamespace(
        ark_api_key="synthetic-secret", ark_base_url="https://fixture.invalid",
        ark_model="fixture-model",
    ))
    monkeypatch.setattr(probe.httpx, "AsyncHTTPTransport", lambda **kwargs: httpx.MockTransport(handler))
    event = asyncio.run(probe.run_probe())
    assert len(requests) == 1
    assert event["status"] == "partial" and event["provider_assessment_rejected"]
    assert event["missed_opportunities_count"] == 0 and event["used_primary_targets"] == 0
    assert len(event["provider"]["assessment_schema_errors"]) == 3
    assert all(row["type"] == "extra_forbidden" for row in event["provider"]["assessment_schema_errors"])
    assert "Every dimensions entry has exactly id, summary, criteria." in requests[0]["messages"][0]["content"]
    assert "Never add criteria_note" in requests[0]["messages"][0]["content"]


def test_corrected_synthetic_structure_is_ready_without_weakening_extra_or_quote_validation():
    data = probe.synthetic_source()
    output = model(data, quote=None)
    output["item_results"][0]["session_item_id"] = probe.ITEM
    output["missed_opportunities"] = [{
        "session_item_id": probe.ITEM, "opportunity_attempt_id": "synthetic-attempt",
        "opportunity_response_id": "synthetic-response", "original": reference(data["messages"][1]),
        "suggested": "To be fair, the other team needs two days to finish their review.",
        "reason": "Acknowledge the constraint using the stated facts.",
    }]
    for dimension in output["dimensions"]:
        dimension["criteria_note"] = "synthetic optional note"
    with pytest.raises(ValueError):
        probe.assessment._Assessment.model_validate(output)
    for dimension in output["dimensions"]:
        dimension.pop("criteria_note")
    parsed = probe.assessment._Assessment.model_validate(output)
    checks = probe._synthetic_validation_checks(parsed)
    assert all(checks[key] for key in ("reviewed_all_users", "dimension_ids_exact", "criterion_ids_exact",
                                      "rating_references_valid", "item_ids_exact"))
    assert all(checks["suggestions"][0].values())
    status, result = probe.assessment.compile_assessment(data, parsed)
    assert status == "ready" and len(result.missed_opportunities) == 1
    assert result.statistics.used_primary_targets == 0
    output["dimensions"][0]["criteria"][0]["evidence"][0]["quote"] = "fabricated quotation"
    assert not probe._synthetic_validation_checks(probe.assessment._Assessment.model_validate(output))["rating_references_valid"]


def test_v3_null_note_placeholder_is_canonicalized_before_strict_validation():
    data = probe.synthetic_source()
    output = model(data, quote=None)
    output["item_results"][0]["session_item_id"] = probe.ITEM
    output["missed_opportunities"] = [{
        "session_item_id": probe.ITEM, "opportunity_attempt_id": "synthetic-attempt",
        "opportunity_response_id": "synthetic-response", "original": reference(data["messages"][1]),
        "suggested": "To be fair, the other team needs two days to finish their review.",
        "reason": "Acknowledge their stated constraint.",
    }]
    for dimension in output["dimensions"]:
        dimension["criteria_note"] = None
    raw = json.dumps(output)
    parsed = probe.assessment._parse_assessment(raw, include_missed=True)
    assert all("criteria_note" not in row for row in parsed.model_dump()["dimensions"])
    status, result = probe.assessment.compile_assessment(data, parsed)
    assert status == "ready" and len(result.missed_opportunities) == 1
    assert result.statistics.used_primary_targets == 0
    # v1/v2 provider parsing stays strict, and raw source content stays unchanged.
    with pytest.raises(ValueError):
        probe.assessment._parse_assessment(raw, include_missed=False)
    assert json.loads(raw) == output


@pytest.mark.parametrize("field,value", [
    ("criteria_note", "do not discard meaningful text"),
    ("criteria_note", ""),
    ("criteria_note", 0),
    ("criteria_note", False),
    ("criteria_note", {}),
    ("unrequested_note", None),
    ("score", None),
])
def test_v3_note_compatibility_keeps_non_null_and_other_extras_strict(field, value):
    output = model(probe.synthetic_source(), quote=None)
    output["dimensions"][0][field] = value
    with pytest.raises(ValueError):
        probe.assessment._parse_assessment(json.dumps(output), include_missed=True)


def test_synthetic_trace_records_only_count_of_canonicalized_empty_notes():
    output = model(probe.synthetic_source(), quote=None)
    for dimension in output["dimensions"]:
        dimension["criteria_note"] = None
    envelope = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}]}
    trace = {"diagnose_extra_keys": True}

    async def read():
        async def chunks():
            yield json.dumps(envelope).encode()
        async for _ in probe._capture_decoded(chunks(), trace):
            pass

    asyncio.run(read())
    assert trace["canonicalized_empty_notes"] == 3
    assert trace["assessment_schema_valid"]
    assert "The other team" not in json.dumps(trace)
