"""Durable learner records and private objects; no in-memory success fallback."""

from functools import lru_cache

import httpx

from app.config import get_settings
from app.integrations.supabase_repository import SupabaseRepository, get_supabase_repository

BUCKET = "shadow-recordings"


class PracticeRepository:
    def __init__(self, database: SupabaseRepository, url: str, secret: str) -> None:
        self.database = database
        headers = {"apikey": secret}
        if not secret.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {secret}"
        self.storage = httpx.Client(base_url=f"{url.rstrip('/')}/storage/v1/", headers=headers, timeout=30)

    def source_available(self, owner: str, content: str) -> bool:
        rows = self.database._request("GET", "/contents", params={
            "id": f"eq.{content}", "select": "visibility,owner_user_id", "limit": "1",
        }).json()
        return bool(rows and (rows[0]["visibility"] == "public" or rows[0]["owner_user_id"] == owner))

    def get(self, owner: str, attempt: str) -> dict | None:
        rows = self.database._request("GET", "/shadow_attempts", params={
            "user_id": f"eq.{owner}", "id": f"eq.{attempt}", "select": "*", "limit": "1",
        }).json()
        return rows[0] if rows else None

    def create(self, row: dict) -> dict:
        self.database._request("POST", "/profiles", params={"on_conflict": "id"},
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"}, json={"id": row["user_id"]})
        rows = self.database._request("POST", "/shadow_attempts", params={"on_conflict": "id"},
            headers={"Prefer": "resolution=ignore-duplicates,return=representation"}, json=row).json()
        return rows[0] if rows else self.get(row["user_id"], row["id"])

    def list(self, owner: str, content: str, sentence: str | None, offset: int, limit: int) -> list[dict]:
        params = {"user_id": f"eq.{owner}", "content_id": f"eq.{content}", "deleted_at": "is.null",
                  "select": "*", "order": "created_at.desc,id.desc", "offset": str(offset), "limit": str(limit)}
        if sentence is not None:
            params["sentence_id"] = f"eq.{sentence}"
        return self.database._request("GET", "/shadow_attempts", params=params).json()

    def update(self, owner: str, attempt: str, changes: dict, *, pending_only: bool = False) -> dict | None:
        params = {"user_id": f"eq.{owner}", "id": f"eq.{attempt}"}
        if pending_only:
            params.update({"recording_state": "eq.pending", "deleted_at": "is.null"})
        rows = self.database._request("PATCH", "/shadow_attempts", params=params,
            headers={"Prefer": "return=representation"}, json=changes).json()
        return rows[0] if rows else None

    @staticmethod
    def object_key(row: dict) -> str:
        # Only server-created UUID/hash values form paths. Never accept a client path.
        return f"{row['id']}/{row['recording_sha256']}"

    def upload(self, row: dict, data: bytes) -> None:
        response = self.storage.post(f"object/{BUCKET}/{self.object_key(row)}", content=data,
            headers={"Content-Type": row["recording_mime"], "x-upsert": "false"})
        # A prior uncertain request may have already stored these exact immutable bytes.
        if response.status_code in (400, 409) and response.json().get("error") in ("Duplicate", "ResourceAlreadyExists"):
            return
        response.raise_for_status()

    def read_audio(self, row: dict) -> bytes:
        response = self.storage.get(f"object/{BUCKET}/{self.object_key(row)}")
        response.raise_for_status()
        return response.content

    def remove_audio(self, row: dict) -> None:
        if row.get("recording_sha256"):
            response = self.storage.request("DELETE", f"object/{BUCKET}", json={"prefixes": [self.object_key(row)]})
            response.raise_for_status()


@lru_cache
def get_practice_repository() -> PracticeRepository | None:
    settings = get_settings()
    database = get_supabase_repository()
    if database is None:
        return None
    return PracticeRepository(database, settings.supabase_url or "", settings.supabase_secret_key or "")
