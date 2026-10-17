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
    analysis_version: str = "mvp-v9"
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
    deepseek_max_output_tokens: int = 32000

    # Stage 4 has separate, bounded requests; these never use Stage 1 token budgets.
    openai_api_key: str | None = None
    speaking_realtime_provider: Literal["gemini", "openai"] = "gemini"
    gemini_api_key: str | None = None
    gemini_live_model: str = "gemini-3.8-live"
    gemini_live_voice: str = "Kore"
    openai_realtime_model: str = "gpt-realtime"
    openai_realtime_voice: str = "marin"
    openai_transcription_model: str = "gpt-4o-mini-transcribe"
    speaking_max_connection_seconds: int = Field(default=1200, ge=60, le=1800)
    speaking_max_turns: int = Field(default=100, ge=1, le=100)
    speaking_idle_seconds: int = Field(default=180, ge=30, le=600)
    speaking_lease_seconds: int = Field(default=60, ge=20, le=120)
    speaking_max_output_tokens: int = Field(default=450, ge=64, le=1000)

    punctuation_model_path: str | None = None
    punctuation_bpe_vocab_path: str | None = None
    punctuation_num_threads: int = Field(default=1, ge=1, le=8)
    punctuation_window_words: int = Field(default=120, ge=40, le=500)
    punctuation_overlap_words: int = Field(default=20, ge=5, le=100)
    transcript_preview_limit: int = Field(default=1000, ge=20, le=2000)

    # Optional, server-managed source grants. Never accept file paths from clients.
    acoustic_sources_path: str | None = None
    practice_asr_model_path: str | None = None
    practice_asr_model_sha256: str | None = None
    acoustic_mfa_binary: str = "mfa"
    acoustic_mfa_dictionary: str | None = None
    acoustic_mfa_model: str | None = None
    acoustic_mfa_dictionary_sha256: str | None = None
    acoustic_mfa_model_sha256: str | None = None
    acoustic_silero_path: str | None = None
    acoustic_lease_seconds: int = Field(default=120, ge=30, le=900)
    acoustic_poll_seconds: float = Field(default=0.5, ge=0.5, le=60)
    acoustic_scheduler_path: str = ".cache/acoustic-scheduler"
    acoustic_fast_cpus: str = ""
    acoustic_fine_cpus: str = ""
    acoustic_fine_nice: int = Field(default=10, ge=0, le=19)
    acoustic_audio_cache_path: str = ".cache/analysis-audio"
    acoustic_mfa_cache_path: str = ".cache/mfa-runtime"

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
