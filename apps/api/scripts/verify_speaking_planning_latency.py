"""Opt-in, database-free Ark probe: five targets, one scene, one injected field repair.

Run from apps/api: .venv/bin/python scripts/verify_speaking_planning_latency.py
    --run-live --output /absolute/path/results.json

At most three real model calls: one normal plan (including its optional repair),
then one repair of a deliberately removed slot in the accepted synthetic plan.
The injected first response is replayed locally, not another model generation.
Only fixed labels, counts and timings are saved. No learner records are read/written.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from time import perf_counter
from uuid import NAMESPACE_DNS, uuid4, uuid5

API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_ROOT))
os.chdir(API_ROOT)

from app.schemas.speaking_plan import SpeakingPlanCreate
from app.services import speaking_planning as planning
from app.services.speaking_timing import request_timing


def fixture():
    expressions = [
        ("That's where you get a foothold", "Establish an initial position in a market."),
        ("A lot of light bulbs have come on over the last 90 days", "Recent strategic insights."),
        ("eek out a beach head", "Gain a small foothold in a new market."),
        ("come to fruition", "A plan achieves its intended results."),
        ("pinch me moment.", "An exciting moment that feels too good to be real."),
    ]
    snapshots = [{
        "corpus_item_id": str(uuid5(NAMESPACE_DNS, "libitu-loadout-probe-" + str(index))),
        "kind": "chunk" if index < 2 else "idiom", "text": text, "meaning": meaning,
        "usage_note": "", "tags": [], "slots": {}, "source_title": "Synthetic business practice",
        "register": None, "scenario_tags": [], "pattern_family": None,
    } for index, (text, meaning) in enumerate(expressions)]
    payload = SpeakingPlanCreate(scenario_type="workplace", candidate_count=1, targets=[
        {"corpus_item_id": item["corpus_item_id"], "role": "primary" if index < 3 else "opportunity"}
        for index, item in enumerate(snapshots)
    ])
    context = {
        "scenario_type": payload.scenario_type, "brief": "", "candidate_count": 1,
        "targets": [{**item, "role": target.role} for item, target in zip(snapshots, payload.targets, strict=True)],
        "output_schema": planning._generation_schema(payload),
    }
    return payload, snapshots, context


async def run(output: Path):
    events, requests = [], 0
    original = planning.request_analysis_json
    phase = "single_scene"

    def emit(event, **fields):
        row = {"event": event, "phase": phase, **fields}
        events.append(row)
        print(json.dumps(row), flush=True)
        output.write_text(json.dumps(events, indent=2) + "\n")

    async def observed(*args, **kwargs):
        nonlocal requests
        requests += 1
        assert requests <= 3, "model_request_budget"
        raw, trace = await original(*args, **kwargs)
        emit("provider", **{key: trace.get(key) for key in ("elapsed_ms", "usage", "finish_reason")},
             max_tokens=kwargs["max_tokens"], repair_fields=len(args[2].get("repair_tasks", [])))
        return raw, trace

    payload, snapshots, context = fixture()
    passed = False
    try:
        planning.request_analysis_json = observed
        with request_timing("plan") as timing:
            started = perf_counter()
            result, attempts = await planning._generate_valid_proposals(uuid4().hex, payload, snapshots, context)
            emit("validated", attempts=attempts, candidates=len(result.candidates),
                 targets=len(result.candidates[0].targets), elapsed_ms=round((perf_counter() - started) * 1000, 2),
                 durations_ms={key: round(value, 2) for key, value in timing.durations_ms.items()})
        phase = "injected_missing_slot_repair"
        document = result.model_dump(mode="json", by_alias=True)
        document["candidates"][0]["targets"][3]["sentence_frame"] = "{{target}}"
        replayed = False

        async def replay_then_repair(*args, **kwargs):
            nonlocal replayed
            if not replayed:
                replayed = True
                return json.dumps(document), {}
            tasks = args[2]["repair_tasks"]
            assert [task["path"] for task in tasks] == [["candidates", 0, "targets", 3, "sentence_frame"]]
            return await observed(*args, **kwargs)

        planning.request_analysis_json = replay_then_repair
        with request_timing("plan") as timing:
            repaired, attempts = await planning._generate_valid_proposals(uuid4().hex, payload, snapshots, context)
            after = repaired.model_dump(mode="json", by_alias=True)
            document["candidates"][0]["targets"][3]["sentence_frame"] = after["candidates"][0]["targets"][3]["sentence_frame"]
            assert after == document, "untouched_fields_changed"
            emit("validated", attempts=attempts, patched_fields=1, untouched_fields_preserved=True,
                 durations_ms={key: round(value, 2) for key, value in timing.durations_ms.items()})
        passed = True
    except Exception as error:
        emit("failed", kind=type(error).__name__, code=(getattr(error, "headers", None) or {}).get("X-Speaking-Plan-Error"))
    finally:
        planning.request_analysis_json = original
        emit("completed", passed=passed, real_model_requests=requests, database_requests=0,
             qualification="synthetic transport and validation, not teaching quality or latency distribution")
    return passed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-live", action="store_true", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    raise SystemExit(0 if asyncio.run(run(args.output)) else 1)
