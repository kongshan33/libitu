import pytest

from app.config import get_settings
from app.integrations.supabase_repository import get_supabase_repository


@pytest.fixture(autouse=True)
def use_inline_processing(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PROCESSING_MODE", "inline")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "")
    get_settings.cache_clear()
    get_supabase_repository.cache_clear()
    yield
    get_settings.cache_clear()
    get_supabase_repository.cache_clear()
