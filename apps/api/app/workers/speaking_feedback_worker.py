"""Durable Stage 5 worker. No model request depends on a page or API process staying open."""

import argparse
import asyncio
import logging
from threading import Event

from app.config import get_settings
from app.integrations.speaking_feedback_repository import get_feedback_store
from app.schemas.speaking_feedback import ANALYSIS_VERSION, RUBRIC_VERSION, FeedbackResult
from app.services.speaking_assessment import INPUT_LIMIT_NOTICE, PROVIDER_UNAVAILABLE_NOTICE, assess_feedback

log = logging.getLogger(__name__)
DEADLINE_SECONDS = 75


async def process_job(repository, job: dict) -> bool:
    result = None
    previous_result = None
    if job.get("result") is not None:
        try:
            previous_result = FeedbackResult.model_validate(job["result"]).model_dump(mode="json")
        except ValueError:
            pass
    status = "failed"
    error_code = None
    try:
        if job["analysis_version"] != ANALYSIS_VERSION or job["rubric_version"] != RUBRIC_VERSION:
            error_code = "worker_version_mismatch"
        else:
            status, assessed = await asyncio.wait_for(assess_feedback(job["source"]), DEADLINE_SECONDS)
            if status not in ("ready", "partial", "insufficient_data"):
                raise ValueError("Unexpected assessment state")
            result = FeedbackResult.model_validate(assessed).model_dump(mode="json")
            if status == "partial":
                error_code = ("input_limit" if INPUT_LIMIT_NOTICE in result["notices"] else
                              "provider_unavailable" if PROVIDER_UNAVAILABLE_NOTICE in result["notices"] else
                              "assessment_incomplete")
                if error_code == "provider_unavailable" and previous_result is not None:
                    result = previous_result
                    if PROVIDER_UNAVAILABLE_NOTICE not in result["notices"]:
                        result["notices"].append(PROVIDER_UNAVAILABLE_NOTICE)
    except TimeoutError:
        status, error_code = "failed", "assessment_timeout"
    except Exception:
        # Provider exceptions may contain request bodies or credentials. Never log them.
        status, error_code = "failed", "assessment_failed"
    if status == "failed" and result is None:
        # A failed retry cannot erase previously validated feedback for this same
        # immutable input. It stays visible alongside the latest failure state.
        result = previous_result
    # If storage is unavailable the lease expires and the next worker reclaims it.
    return await asyncio.to_thread(
        repository.complete, job["id"], job["lease_token"], status, result, error_code=error_code,
    )


def reconcile(repository) -> int:
    """Repair a process exit between ending a mission and requesting its report."""
    count = 0
    for row in repository.pending_sessions(limit=10):
        try:
            if repository.enqueue(row["user_id"], row["session_id"]) is not None:
                count += 1
        except Exception:
            # A single deleted/invalid/unavailable source must not starve other jobs.
            log.warning("A completed mission awaits feedback reconciliation.")
    return count


async def run_once(repository) -> bool:
    await asyncio.to_thread(reconcile, repository)
    job = await asyncio.to_thread(repository.claim)
    if not job:
        return False
    await process_job(repository, job)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    if not get_settings().supabase_server_is_configured:
        log.info("Speaking feedback worker needs configured durable storage; inline fixtures run in-process.")
        return
    repository = get_feedback_store()
    while True:
        try:
            processed = asyncio.run(run_once(repository))
        except Exception:
            # Sanitized operational event only: no private text or provider exception.
            log.warning("Speaking feedback storage unavailable; jobs remain recoverable.")
            processed = False
        if args.once:
            return
        if not processed:
            Event().wait(3)


if __name__ == "__main__":
    main()
