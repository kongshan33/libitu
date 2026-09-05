import json
from dataclasses import dataclass
from datetime import UTC, datetime

from app.config import get_settings
from app.integrations.upstash import get_upstash_redis
from app.schemas.blueprint import Blueprint
from app.schemas.content import ContentResolveResponse
from app.schemas.job import ProcessingJob


@dataclass(frozen=True)
class QueuedContent:
    content: ContentResolveResponse
    transcript_text: str | None


def save_content(content: ContentResolveResponse, transcript_text: str | None) -> None:
    payload = {"content": content.model_dump(mode="json"), "transcript_text": transcript_text}
    _set_json(_content_key(content.content_id), payload)


def get_content(content_id: str) -> QueuedContent | None:
    payload = _get_json(_content_key(content_id))
    if payload is None:
        return None
    return QueuedContent(
        content=ContentResolveResponse.model_validate(payload["content"]),
        transcript_text=payload.get("transcript_text"),
    )


def save_job(job: ProcessingJob) -> None:
    settings = get_settings()
    redis = _redis()
    pipeline = redis.pipeline()
    pipeline.set(
        _job_key(job.id),
        json.dumps(job.model_dump(mode="json"), separators=(",", ":")),
        ex=settings.processing_state_ttl_seconds,
    )
    pipeline.set(
        _job_index_key(job.content_id, job.analysis_version),
        job.id,
        ex=settings.processing_state_ttl_seconds,
    )
    pipeline.exec()


def get_job(job_id: str) -> ProcessingJob | None:
    payload = _get_json(_job_key(job_id))
    return ProcessingJob.model_validate(payload) if payload is not None else None


def find_job(content_id: str, analysis_version: str) -> ProcessingJob | None:
    job_id = _redis().get(_job_index_key(content_id, analysis_version))
    return get_job(str(job_id)) if job_id else None


def enqueue(job_id: str) -> None:
    redis = _redis()
    queue_name = get_settings().processing_queue_name
    if redis.lpos(queue_name, job_id) is None:
        redis.rpush(queue_name, job_id)


def dequeue() -> str | None:
    job_id = _redis().lpop(get_settings().processing_queue_name)
    return str(job_id) if job_id else None


def acquire_lock(job_id: str, ttl_seconds: int | None = None) -> bool:
    if ttl_seconds is None:
        ttl_seconds = get_settings().processing_lock_ttl_seconds
    return bool(_redis().set(f"libitu:lock:job:{job_id}", "1", nx=True, ex=ttl_seconds))


def release_lock(job_id: str) -> None:
    _redis().delete(f"libitu:lock:job:{job_id}")


def save_blueprint(blueprint: Blueprint) -> None:
    _set_json(
        _blueprint_key(blueprint.content_id, blueprint.analysis_version),
        blueprint.model_dump(mode="json"),
    )


def get_blueprint(content_id: str, analysis_version: str) -> Blueprint | None:
    payload = _get_json(_blueprint_key(content_id, analysis_version))
    return Blueprint.model_validate(payload) if payload is not None else None


def invalidate_content(content_id: str, analysis_version: str | None = None) -> None:
    analysis_version = analysis_version or get_settings().analysis_version
    redis = _redis()
    job_id = redis.get(_job_index_key(content_id, analysis_version))
    keys = [
        _job_index_key(content_id, analysis_version),
        _blueprint_key(content_id, analysis_version),
        _legacy_blueprint_key(content_id),
    ]
    if job_id:
        keys.append(_job_key(str(job_id)))
    redis.delete(*keys)


def _redis():
    redis = get_upstash_redis()
    if redis is None:
        raise RuntimeError("Upstash Redis is required for queue processing.")
    return redis


def _set_json(key: str, payload: dict) -> None:
    _redis().set(
        key,
        json.dumps(payload, separators=(",", ":")),
        ex=get_settings().processing_state_ttl_seconds,
    )


def _get_json(key: str) -> dict | None:
    value = _redis().get(key)
    return json.loads(value) if value else None


def _content_key(content_id: str) -> str:
    return f"libitu:content:{content_id}"


def _job_key(job_id: str) -> str:
    return f"libitu:job:{job_id}"


def _job_index_key(content_id: str, analysis_version: str) -> str:
    return f"libitu:job-index:{content_id}:{analysis_version}"


def save_worker_heartbeat() -> None:
    settings = get_settings()
    _redis().set(
        _worker_heartbeat_key(),
        json.dumps(
            {
                "timestamp": datetime.now(UTC).isoformat(),
                "analysis_version": settings.analysis_version,
                "model": settings.deepseek_model,
            },
            separators=(",", ":"),
        ),
        ex=settings.worker_heartbeat_ttl_seconds,
    )


def get_worker_heartbeat() -> dict[str, str] | None:
    value = _redis().get(_worker_heartbeat_key())
    if not value:
        return None
    try:
        payload = json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return {"timestamp": str(value), "analysis_version": "unknown", "model": "unknown"}
    if not isinstance(payload, dict):
        return {"timestamp": str(value), "analysis_version": "unknown", "model": "unknown"}
    return {
        "timestamp": str(payload.get("timestamp", "unknown")),
        "analysis_version": str(payload.get("analysis_version", "unknown")),
        "model": str(payload.get("model", "unknown")),
    }


def _blueprint_key(content_id: str, analysis_version: str) -> str:
    return f"libitu:blueprint:{content_id}:{analysis_version}"


def _legacy_blueprint_key(content_id: str) -> str:
    return f"libitu:blueprint:{content_id}"


def _worker_heartbeat_key() -> str:
    return f"libitu:worker-heartbeat:{get_settings().processing_queue_name}"
