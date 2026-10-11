"""Record an explicit authenticated visit without starting content processing."""
from datetime import datetime, timezone

import httpx

from app.config import get_settings
from app.integrations.profile_repository import unavailable
from app.integrations.supabase_repository import get_supabase_repository
from app.services import store
from app.services.content_context import read_public_content


def remember_video(owner: str, content_id: str) -> None:
    # Metadata-only access check, including durable visibility/deletion checks.
    read_public_content(content_id)
    now = datetime.now(timezone.utc).isoformat()
    try:
        database = get_supabase_repository()
        if database is not None:
            database._request("POST", "/profiles", params={"on_conflict": "id"},
                headers={"Prefer": "resolution=ignore-duplicates,return=minimal"}, json={"id": owner})
            database._request("POST", "/user_content_states", params={"on_conflict": "user_id,content_id"},
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                json={"user_id": owner, "content_id": content_id, "last_opened_at": now})
            return
        settings = get_settings()
        if settings.supabase_server_is_configured or settings.processing_mode != "inline":
            raise unavailable()
        store.content_visits[(owner, content_id)] = now
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        raise unavailable() from None
