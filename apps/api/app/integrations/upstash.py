from functools import lru_cache

import httpx
from upstash_redis import Redis

from app.config import get_settings


@lru_cache
def get_upstash_redis() -> Redis | None:
    settings = get_settings()
    if not settings.upstash_is_configured:
        return None
    redis = Redis(
        url=settings.upstash_redis_rest_url,
        token=settings.upstash_redis_rest_token,
        rest_retries=settings.upstash_max_retries,
        rest_retry_interval=settings.upstash_retry_interval_seconds,
    )
    # The current upstash-redis client otherwise leaves HTTP requests unbounded.
    redis._http._client.timeout = httpx.Timeout(settings.upstash_timeout_seconds)
    return redis
