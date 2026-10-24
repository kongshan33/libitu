import asyncio
import json
import logging
import re
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.concurrency import run_in_threadpool

from app.auth import AuthenticatedUser, require_user
from app.main import app
from app.routers import speaking
from app.schemas.corpus import CorpusItemCreate
from app.services import corpus_service, speaking_planning, speaking_timing, store


def header_durations(response):
    values = {}
    for metric in response.headers["Server-Timing"].split(", "):
        match = re.fullmatch(r"([a-z_]+);dur=(\d+\.\d{2})", metric)
        assert match, metric
        values[match[1]] = float(match[2])
    assert re.fullmatch(r"[a-f0-9]{32}", response.headers["X-Request-ID"])
    return values


@pytest.fixture
def authenticated_client():
    previous = app.dependency_overrides.copy()
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="timing-private-owner")
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)
    store.speaking_sessions.clear()
    store.speaking_session_submissions.clear()
    store.speaking_plans.clear()


def test_phases_accumulate_failed_work_and_finish_once(monkeypatch, caplog):
    clock = iter([10.0, 10.1, 10.15, 10.2, 10.275, 10.4])
    monkeypatch.setattr(speaking_timing, "perf_counter", lambda: next(clock))
    with caplog.at_level(logging.INFO, logger=speaking_timing.__name__):
        with speaking_timing.request_timing("plan") as timing:
            with speaking_timing.measure_phase("validation"):
                pass
            with pytest.raises(ValueError), speaking_timing.measure_phase("validation"):
                raise ValueError("private source contents")
            headers = timing.finish(503)
            assert timing.finish(503) == headers
    assert timing.durations_ms == pytest.approx({"validation": 125, "total": 400})
    assert speaking_timing.current_request_id() is None
    assert len(caplog.records) == 1
    document = json.loads(caplog.records[0].getMessage().split(" ", 1)[1])
    assert document == {
        "request_id": timing.request_id, "operation": "plan", "status_code": 503,
        "outcome": "failed", "durations_ms": {"validation": 125, "total": 400},
    }
    assert "private" not in caplog.text


def test_parallel_requests_and_worker_threads_keep_separate_timing_contexts():
    async def operation(name, phase):
        with speaking_timing.request_timing(name) as timing:
            with speaking_timing.measure_phase(phase):
                await asyncio.sleep(0)
                def read_in_worker():
                    with speaking_timing.measure_phase("validation"):
                        return speaking_timing.current_request_id()
                assert await run_in_threadpool(read_in_worker) == timing.request_id
            timing.finish(200)
            return timing

    async def run():
        return await asyncio.gather(operation("plan", "input_read"), operation("create", "create"))

    first, second = asyncio.run(run())
    assert first.request_id != second.request_id
    assert set(first.durations_ms) == {"input_read", "validation", "total"}
    assert set(second.durations_ms) == {"create", "validation", "total"}
    assert speaking_timing.current_request_id() is None


def test_unknown_labels_cannot_enter_logs_or_headers():
    with pytest.raises(ValueError, match="Unknown preparation operation"):
        with speaking_timing.request_timing("private source text"):
            pass
    with pytest.raises(ValueError, match="Unknown preparation timing phase"):
        with speaking_timing.measure_phase("private source text"):
            pass


def test_create_and_workspace_expose_separate_read_timings(authenticated_client, caplog):
    item = corpus_service.create_corpus_item("timing-private-owner", CorpusItemCreate(
        kind="chunk", text="private target contents", meaning="private meaning",
        source_locator={"source_title": "private source"},
    ))
    with caplog.at_level(logging.INFO, logger=speaking_timing.__name__):
        created = authenticated_client.post("/api/speaking/sessions", json={
            "client_id": str(uuid4()), "scenario_type": "workplace", "goal": "private learner goal",
            "corpus_item_ids": [item.id],
        })
        assert created.status_code == 201, created.text
        assert set(header_durations(created)) == {"create", "total"}
        workspace = authenticated_client.get(f"/api/speaking/sessions/{created.json()['id']}/workspace")
        assert workspace.status_code == 200, workspace.text
        assert set(header_durations(workspace)) == {"workspace_session_read", "workspace_runtime_read", "total"}
    assert created.headers["X-Request-ID"] != workspace.headers["X-Request-ID"]
    assert len(caplog.records) == 2
    assert "private" not in caplog.text
    assert created.json()["id"] not in caplog.text
    assert item.id not in caplog.text
    assert "Server-Timing" not in authenticated_client.get("/api/speaking/options").headers


def test_failed_plan_preserves_error_headers_and_partial_timing(authenticated_client, monkeypatch):
    async def failed(_owner, _payload):
        with speaking_timing.measure_phase("model_generation"):
            raise HTTPException(503, "Please retry.", headers={
                "X-Speaking-Plan-Error": "provider_transport_error",
                "X-Speaking-Plan-Request-ID": speaking_timing.current_request_id(),
                "Retry-After": "1",
            })

    monkeypatch.setattr(speaking, "create_speaking_plan", failed)
    response = authenticated_client.post("/api/speaking/plans", json={
        "scenario_type": "workplace",
        "targets": [{"corpus_item_id": str(uuid4()), "role": "primary"}],
    })
    assert response.status_code == 503
    assert set(header_durations(response)) == {"model_generation", "total"}
    assert response.headers["X-Speaking-Plan-Request-ID"] == response.headers["X-Request-ID"]
    assert response.headers["X-Speaking-Plan-Error"] == "provider_transport_error"
    assert response.headers["Retry-After"] == "1"


@pytest.mark.parametrize("needs_repair", [False, True])
def test_planner_phases_reach_response_and_share_request_id(
    authenticated_client, monkeypatch, caplog, needs_repair,
):
    item = corpus_service.create_corpus_item("timing-private-owner", CorpusItemCreate(
        kind="chunk", text="to be fair", meaning="Acknowledge another view",
        source_locator={"source_title": "private source"},
    ))
    calls = []

    async def generated(_settings, _prompt, context, **_kwargs):
        calls.append(context)
        if context.get("repair_tasks"):
            return json.dumps({"repairs": {
                task["id"]: "{{target}}, [your own point]." for task in context["repair_tasks"]
            }}), {}
        return json.dumps({"candidates": [{
            "title": "Agree on a deadline", "setting": "Colleagues discuss competing schedule needs.",
            "goal": "Agree on a feasible date", "user_role": "Project lead", "ai_role": "Delivery manager",
            "register": "professional", "targets": [{
                "corpus_item_id": item.id, "role": "primary", "fit": "high",
                "fit_reason": "Each colleague has a reasonable concern.",
                "communicative_function": "Acknowledge an opposing view",
                "trigger_question": "What is reasonable about the other team's concern?",
                "skip_when": "No competing concern is presented.",
                "sentence_frame": "{{target}}" if needs_repair else "{{target}}, [your own point].",
            }],
        }]}), {}

    monkeypatch.setattr(speaking_planning, "request_analysis_json", generated)
    with caplog.at_level(logging.INFO):
        response = authenticated_client.post("/api/speaking/plans", json={
            "scenario_type": "workplace", "candidate_count": 1,
            "targets": [{"corpus_item_id": item.id, "role": "primary"}],
        })
    assert response.status_code == 201, response.text
    phases = {"input_read", "model_generation", "validation", "save_plan", "total"}
    if needs_repair:
        phases.add("model_repair")
    assert set(header_durations(response)) == phases
    assert len(calls) == (2 if needs_repair else 1)
    events = [json.loads(record.getMessage().split(" ", 1)[1]) for record in caplog.records
              if record.name in {speaking_planning.__name__, speaking_timing.__name__}]
    assert events and {event["request_id"] for event in events} == {response.headers["X-Request-ID"]}


def test_rejected_request_reports_total_without_inventing_model_time(authenticated_client):
    response = authenticated_client.post("/api/speaking/plans", json={"brief": "private invalid request"})
    assert response.status_code == 422
    assert set(header_durations(response)) == {"total"}
    assert "private" not in response.text


def test_unavailable_workspace_records_only_attempted_read(authenticated_client):
    response = authenticated_client.get(f"/api/speaking/sessions/{uuid4()}/workspace")
    assert response.status_code == 404
    assert set(header_durations(response)) == {"workspace_session_read", "total"}
