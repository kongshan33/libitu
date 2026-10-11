import json
from dataclasses import dataclass
from datetime import UTC, datetime

from app.config import get_settings
from app.integrations.upstash import get_upstash_redis
from app.schemas.blueprint import Blueprint
from app.schemas.captions import CaptionTrack
from app.schemas.content import ContentResolveResponse
from app.schemas.job import ProcessingJob


@dataclass(frozen=True)
class QueuedContent:
    content: ContentResolveResponse
    transcript_text: str | None
    caption_track: CaptionTrack | None = None


def save_content(
    content: ContentResolveResponse, transcript_text: str | None,
    caption_track: CaptionTrack | None = None,
) -> None:
    payload = {"content": content.model_dump(mode="json"), "transcript_text": transcript_text}
    if caption_track is not None:
        payload["caption_track"] = caption_track.model_dump(mode="json", exclude_none=True)
    _set_json(_content_key(content.content_id), payload)


def get_content(content_id: str) -> QueuedContent | None:
    payload = _get_json(_content_key(content_id))
    if payload is None:
        return None
    return QueuedContent(
        content=ContentResolveResponse.model_validate(payload["content"]),
        transcript_text=payload.get("transcript_text"),
        caption_track=CaptionTrack.model_validate(payload["caption_track"]) if payload.get("caption_track") else None,
    )


def save_job(job: ProcessingJob) -> None:
    _write_job(job, "publish")


def create_job_once(job: ProcessingJob) -> ProcessingJob:
    return ProcessingJob.model_validate_json(_write_job(job, "create"))


def compare_and_swap_job(previous: ProcessingJob, updated: ProcessingJob) -> ProcessingJob | None:
    if (updated.id, updated.content_id, updated.analysis_version) != (previous.id, previous.content_id, previous.analysis_version):
        raise ValueError("A processing transition cannot change identity")
    value = _write_job(updated, "compare", previous)
    return ProcessingJob.model_validate_json(value) if value else None


def _write_job(job: ProcessingJob, mode: str, previous: ProcessingJob | None = None):
    return _redis().eval(_JOB_WRITE, [_job_key(job.id), _job_index_key(job.content_id, job.analysis_version)], [
        job.model_dump_json(), get_settings().processing_state_ttl_seconds, mode,
        str(previous.attempt_count if previous else -1), previous.status.value if previous else "",
    ])


# Both state and index change atomically. A delayed cache publisher cannot
# overwrite a newer retry, restart a terminal job, or regress processing to pending.
_JOB_WRITE = """
local raw = redis.call('GET', KEYS[1])
local candidate = cjson.decode(ARGV[1])
local mode = ARGV[3]
if raw then
  local old = cjson.decode(raw)
  if old.content_id ~= candidate.content_id or old.analysis_version ~= candidate.analysis_version then
    return redis.error_reply('processing identity conflict')
  end
  if mode == 'create' then return raw end
  if mode == 'compare' then
    if old.attempt_count ~= tonumber(ARGV[4]) or old.status ~= ARGV[5] then return false end
  elseif old.attempt_count > candidate.attempt_count or
    (old.attempt_count == candidate.attempt_count and
      ((old.status == 'ready' or old.status == 'failed') and old.status ~= candidate.status or
       old.status == 'processing' and candidate.status == 'pending')) then return raw end
elseif mode == 'compare' then return false end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[2], candidate.id, 'EX', ARGV[2])
return ARGV[1]
"""


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
