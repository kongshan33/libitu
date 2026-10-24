"""Opt-in Stage 5 Doubao + durable-report smoke, using isolated synthetic records.

Run from apps/api: uv run python -m scripts.smoke_speaking_feedback --live
The script does not connect a microphone or read any real learner's mission.
"""

import argparse
import asyncio
import json
from datetime import datetime, timezone
from uuid import uuid4

from app.config import get_settings
from app.integrations.speaking_feedback_repository import get_feedback_store
from app.schemas.corpus import CorpusItemCreate
from app.schemas.speaking import SpeakingSessionCreate
from app.services import corpus_service, speaking_service, speaking_runtime_state
from app.services.speaking_feedback_service import read_feedback, request_feedback
from app.workers.speaking_feedback_worker import process_job


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    if not args.live:
        parser.error("Pass --live to enable one bounded paid assessment of synthetic text.")
    settings = get_settings()
    if not settings.supabase_server_is_configured or not settings.ark_is_configured:
        parser.error("Configure durable storage and the assessment provider first.")
    owner = "libitu-stage5-smoke-" + uuid4().hex
    items, session = [], None
    try:
        for text in ("One trade-off is", "to be fair"):
            items.append(corpus_service.create_corpus_item(owner, CorpusItemCreate(
                kind="chunk", text=text, source_locator={"source_title": "Synthetic Stage 5 acceptance"},
            )))
        session = speaking_service.create_speaking_session(owner, SpeakingSessionCreate(
            client_id=uuid4(), scenario_type="workplace", difficulty="standard", feedback_level="balanced",
            goal="Agree with a colleague on a small database migration trial and a next step.",
            corpus_item_ids=[item.id for item in items],
        ))
        sid = str(session.id)
        turns = [
            ("assistant", "What would you suggest we do about the database migration?"),
            ("user", "One trade-off is that the new database scales better, but complex queries will be harder. I suggest we test it on one small service before committing."),
            ("assistant", "That sounds reasonable. How would you address the risk to the current service?"),
            ("user", "To be fair, the current service is stable. We can keep it running during the trial and compare the results before deciding whether to migrate."),
            ("assistant", "Agreed. What should we do next?"),
            ("user", "I can draft the trial plan and send it to you for review. We can agree on success criteria together before starting."),
            ("assistant", "That works for me. Let's review the trial plan together."),
        ]
        now = datetime.now(timezone.utc).isoformat()
        messages = [{"id": str(uuid4()), "ordinal": i, "role": role, "text": text,
                     "input_source": "text", "status": "final", "revision": 1, "created_at": now}
                    for i, (role, text) in enumerate(turns)]
        # Deliberately leave the last realtime analysis pending: final scoring must
        # assess the actual complete transcript, not trust only Stage 4 counters.
        speaking_runtime_state.mutate(owner, sid, lambda document, _: document.update(
            messages=messages, analysis_status="pending", evidence=[], controller={"exposures": []}))
        speaking_runtime_state.end_session(owner, sid)
        requested = request_feedback(owner, sid)
        duplicate = request_feedback(owner, sid)
        assert requested.id == duplicate.id and requested.input_hash == duplicate.input_hash
        repository = get_feedback_store()
        assert repository.read("not-the-owner", sid) is None
        job = repository.claim(requested.id)
        assert job and job["session_id"] == sid
        assert asyncio.run(process_job(repository, job))
        restored = read_feedback(owner, sid)
        assert restored.status == "ready", f"Synthetic assessment incomplete: {restored.error_code}"
        assert restored.result and len(restored.result.dimensions) == 4
        assert restored.result.statistics.assessed_turns == 3
        assert all(dimension.score is not None for dimension in restored.result.dimensions)
        assert all(item.status == "appropriate" for item in restored.result.item_results)
        assert request_feedback(owner, sid).attempts == 1
        print(json.dumps({
            "status": restored.status, "assessed_turns": restored.result.statistics.assessed_turns,
            "scores": {dimension.id: dimension.score for dimension in restored.result.dimensions},
            "item_statuses": [item.status for item in restored.result.item_results],
            "refactors": len(restored.result.refactors), "recovered": True,
            "idempotent": True, "owner_isolated": True,
        }))
    finally:
        if session:
            sid = str(session.id)
            speaking_runtime_state.delete_session(owner, sid)
            assert get_feedback_store().read(owner, sid) is None
        for item in items:
            corpus_service.delete_corpus_item(owner, str(item.id))


if __name__ == "__main__":
    main()
