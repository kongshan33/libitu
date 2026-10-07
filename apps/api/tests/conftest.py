import pytest

from app.config import get_settings
from app.integrations.supabase_repository import get_supabase_repository


@pytest.fixture(autouse=True)
def use_inline_processing(monkeypatch: pytest.MonkeyPatch):
    from app.integrations import sentence_syntax

    # Unit tests remain model-independent; explicit integration evaluations load
    # the real local pipeline separately.
    monkeypatch.setattr(sentence_syntax, "get_sentence_syntax", lambda language=None: None)
    monkeypatch.setenv("PROCESSING_MODE", "inline")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "")
    # Explicit paid smokes live in scripts/, never in automatic test discovery.
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    get_settings.cache_clear()
    get_supabase_repository.cache_clear()
    yield
    get_settings.cache_clear()
    get_supabase_repository.cache_clear()
