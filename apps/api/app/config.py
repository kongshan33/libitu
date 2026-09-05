from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    clerk_secret_key: str | None = None
    clerk_jwt_key: str | None = None
    clerk_authorized_parties: str = "http://localhost:3000"

    supabase_url: str | None = None
    supabase_publishable_key: str | None = None
    supabase_secret_key: str | None = None
    supabase_jwks_url: str | None = None

    upstash_redis_rest_url: str | None = None
    upstash_redis_rest_token: str | None = None

    processing_mode: Literal["inline", "queue"] = "inline"
    analysis_version: str = "mvp-v6"
    processing_queue_name: str = "libitu:queue:blueprints"
    processing_state_ttl_seconds: int = 86400
    processing_lock_ttl_seconds: int = 900
    processing_worker_concurrency: int = 2
    worker_heartbeat_interval_seconds: float = 5.0
    worker_heartbeat_ttl_seconds: int = 20

    upstash_timeout_seconds: float = 10.0
    upstash_max_retries: int = 1
    upstash_retry_interval_seconds: float = 0.5

    deepseek_api_key: str | None = None
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-v4-flash"
    deepseek_timeout_seconds: float = 90.0
    deepseek_max_attempts: int = 2
    deepseek_max_input_chars: int = 240000
    deepseek_max_output_tokens: int = 16000

    punctuation_model_path: str | None = None
    punctuation_bpe_vocab_path: str | None = None
    punctuation_num_threads: int = Field(default=1, ge=1, le=8)
    punctuation_window_words: int = Field(default=120, ge=40, le=500)
    punctuation_overlap_words: int = Field(default=20, ge=5, le=100)
    transcript_preview_limit: int = Field(default=1000, ge=20, le=2000)

    @property
    def authorized_parties(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.clerk_authorized_parties.split(",")
            if origin.strip()
        ]

    @property
    def clerk_is_configured(self) -> bool:
        return bool(self.clerk_secret_key)

    @property
    def upstash_is_configured(self) -> bool:
        return bool(self.upstash_redis_rest_url and self.upstash_redis_rest_token)

    @property
    def queue_is_configured(self) -> bool:
        return self.processing_mode == "queue" and self.upstash_is_configured

    @property
    def deepseek_is_configured(self) -> bool:
        return bool(self.deepseek_api_key)

    @property
    def supabase_server_is_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_secret_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
