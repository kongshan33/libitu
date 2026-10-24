from fastapi import APIRouter, HTTPException

from app.config import get_settings
from app.integrations import processing_queue

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
def readiness_check() -> dict[str, str]:
    settings = get_settings()
    if settings.processing_mode != "queue":
        return {"status": "ok", "processing_mode": "inline", "worker": "disabled"}
    if not settings.upstash_is_configured:
        raise HTTPException(
            status_code=503,
            detail={"status": "degraded", "worker": "unconfigured"},
        )

    try:
        heartbeat = processing_queue.get_worker_heartbeat()
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail={"status": "degraded", "worker": "unreachable", "reason": type(error).__name__},
        ) from error
    if heartbeat is None:
        raise HTTPException(
            status_code=503,
            detail={"status": "degraded", "worker": "missing"},
        )
    if (
        heartbeat["analysis_version"] != settings.analysis_version
        or heartbeat["model"] != settings.ark_model
    ):
        raise HTTPException(
            status_code=503,
            detail={
                "status": "degraded",
                "worker": "stale",
                "expected_analysis_version": settings.analysis_version,
                "worker_analysis_version": heartbeat["analysis_version"],
                "expected_model": settings.ark_model,
                "worker_model": heartbeat["model"],
            },
        )
    return {
        "status": "ok",
        "processing_mode": "queue",
        "worker": "ready",
        "worker_last_seen_at": heartbeat["timestamp"],
        "analysis_version": heartbeat["analysis_version"],
        "model": heartbeat["model"],
    }
