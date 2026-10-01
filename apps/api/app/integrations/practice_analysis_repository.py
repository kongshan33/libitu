from functools import lru_cache

from app.config import get_settings
from app.integrations.practice_repository import PracticeRepository
from app.integrations.supabase_repository import get_supabase_repository

BUCKET = "practice-analysis-inputs"


class PracticeAnalysisRepository(PracticeRepository):
    def get_attempt(self, owner: str, attempt: str) -> dict | None:
        return super().get(owner, attempt)

    def get(self, owner: str, attempt: str) -> dict | None:
        rows = self.database._request("GET", "/practice_analyses", params={
            "id": f"eq.{attempt}", "user_id": f"eq.{owner}", "select": "*", "limit": "1"}).json()
        return rows[0] if rows else None

    def create(self, row: dict) -> dict:
        rows = self.database._request("POST", "/practice_analyses", params={"on_conflict": "id"},
            headers={"Prefer": "resolution=ignore-duplicates,return=representation"}, json=row).json()
        return rows[0] if rows else self.get(row["user_id"], row["id"])

    def control(self, owner: str, attempt: str, action: str) -> dict | None:
        rows = self.database._request("POST", "/rpc/control_practice_analysis", json={
            "p_id": attempt, "p_owner": owner, "p_action": action}).json()
        return rows[0] if rows else None

    def claim(self, token: str, seconds: int) -> dict | None:
        rows = self.database._request("POST", "/rpc/claim_practice_analysis", json={"p_token": token, "p_seconds": seconds}).json()
        return rows[0] if rows else None

    def fenced(self, attempt: str, token: str, action: str, data: dict | None = None) -> bool:
        return self.database._request("POST", "/rpc/update_practice_analysis", json={
            "p_id": attempt, "p_token": token, "p_action": action, "p_data": data or {}}).json() is True

    @staticmethod
    def object_key(row: dict) -> str:
        return f"{row['id']}/{row['input_sha256']}"

    def upload(self, row: dict, data: bytes) -> None:
        response = self.storage.post(f"object/{BUCKET}/{self.object_key(row)}", content=data,
            headers={"Content-Type": row["input_mime"], "x-upsert": "false"})
        if response.status_code in (400, 409) and response.json().get("error") in ("Duplicate", "ResourceAlreadyExists"):
            if self.read_audio(row) == data:
                return
        response.raise_for_status()

    def read_audio(self, row: dict) -> bytes:
        response = self.storage.get(f"object/{BUCKET}/{self.object_key(row)}")
        response.raise_for_status()
        return response.content

    def remove_audio(self, row: dict) -> None:
        response = self.storage.request("DELETE", f"object/{BUCKET}", json={"prefixes": [self.object_key(row)]})
        response.raise_for_status()

    def cleanup_candidates(self, now: str) -> list[dict]:
        # Recheck terminal entries too: an upload that began before deletion may finish late.
        from datetime import datetime, timedelta
        recheck = (datetime.fromisoformat(now) - timedelta(hours=1)).isoformat()
        return self.database._request("GET", "/practice_analyses", params={
            "and": f"(or(input_expires_at.lt.{now},state.in.(completed,needs_review,deleted)),or(input_cleaned_at.is.null,input_cleaned_at.lt.{recheck}))",
            "select": "*", "order": "input_cleaned_at.asc.nullsfirst,created_at", "limit": "100"}).json()

    def mark_clean(self, row: dict, now: str) -> None:
        self.database._request("PATCH", "/practice_analyses", params={"id": f"eq.{row['id']}"},
            json={"input_cleaned_at": now, "input_ready": False})


@lru_cache
def get_practice_analysis_repository() -> PracticeAnalysisRepository | None:
    database = get_supabase_repository()
    settings = get_settings()
    return PracticeAnalysisRepository(database, settings.supabase_url or "", settings.supabase_secret_key or "") if database else None
