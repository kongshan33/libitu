from functools import lru_cache
from hashlib import sha256

from app.config import get_settings
from app.integrations.practice_repository import PracticeRepository
from app.integrations.supabase_repository import get_supabase_repository
from app.services.acoustics import audio_cache

BUCKET = "practice-analysis-inputs"
# Polling never transfers the private 10ms frames or the worker's fine checkpoint.
# Leased claim RPCs still return the complete row for crash recovery.
VIEW_COLUMNS = "id,user_id,reference_id,request_hash,input_sha256,input_bytes,input_mime,consent_version,consent_at,analysis_version,snapshot,state,input_ready,result,error_code,attempts,available_at,input_expires_at,input_cleaned_at,created_at,phase,word_check,coarse_checkpoint"


class PracticeAnalysisRepository(PracticeRepository):
    def get_attempt(self, owner: str, attempt: str) -> dict | None:
        return super().get(owner, attempt)

    def get(self, owner: str, attempt: str) -> dict | None:
        rows = self.database._request("GET", "/practice_analyses", params={
            "id": f"eq.{attempt}", "user_id": f"eq.{owner}", "select": VIEW_COLUMNS, "limit": "1"}).json()
        return rows[0] if rows else None

    def read_snapshot(self, owner: str, attempt: str) -> dict | None:
        return self.database._request("POST", "/rpc/practice_analysis_read_snapshot",
                                      json={"p_owner": owner, "p_id": attempt}).json()

    def submission_rpc(self, name: str, data: dict) -> dict | None:
        import httpx
        from fastapi import HTTPException
        try:
            return self.database._request("POST", f"/rpc/{name}", json=data).json()
        except httpx.HTTPStatusError as error:
            if error.response.status_code in (404, 409):
                raise HTTPException(error.response.status_code, "Submission changed, expired or deleted.") from error
            raise

    def submission_context(self, owner: str, identifier: str) -> dict | None:
        return self.submission_rpc("practice_submission_context", {"p_owner": owner, "p_id": identifier})

    def register_submission(self, owner: str, attempt: dict, analysis: dict) -> dict:
        return self.submission_rpc("register_practice_submission", {
            "p_owner": owner, "p_attempt": attempt, "p_analysis": analysis})

    def finalize_submission(self, owner: str, identifier: str) -> dict:
        return self.submission_rpc("finalize_practice_submission", {"p_owner": owner, "p_id": identifier})

    def mark_recognition_error(self, owner: str, attempt: str) -> dict | None:
        rows = self.database._request("POST", "/rpc/mark_practice_recognition_error",
                                      json={"p_id": attempt, "p_owner": owner}).json()
        return rows[0] if rows else None

    def create(self, row: dict) -> dict:
        rows = self.database._request("POST", "/practice_analyses", params={"on_conflict": "id"},
            headers={"Prefer": "resolution=ignore-duplicates,return=representation"}, json=row).json()
        return rows[0] if rows else self.get(row["user_id"], row["id"])

    def control(self, owner: str, attempt: str, action: str) -> dict | None:
        rows = self.database._request("POST", "/rpc/control_practice_analysis", json={
            "p_id": attempt, "p_owner": owner, "p_action": action}).json()
        return rows[0] if rows else None

    def claim(self, token: str, seconds: int, lane: str = "fast") -> dict | None:
        rows = self.database._request("POST", "/rpc/claim_practice_analysis_lane", json={"p_token": token, "p_seconds": seconds, "p_lane": lane}).json()
        return rows[0] if rows else None

    def fenced(self, attempt: str, token: str, action: str, data: dict | None = None) -> bool:
        if action == "publish_handoff":
            return self.database._request("POST", "/rpc/publish_acoustic_handoff", json={
                "p_kind": "take", "p_id": attempt, "p_token": token, "p_data": data or {}}).json() is True
        if action == "handoff_fine":
            return self.database._request("POST", "/rpc/handoff_acoustic_job", json={
                "p_kind": "take", "p_id": attempt, "p_token": token}).json() is True
        return self.database._request("POST", "/rpc/update_practice_analysis", json={
            "p_id": attempt, "p_token": token, "p_action": action, "p_data": data or {}}).json() is True

    @staticmethod
    def object_key(row: dict) -> str:
        return f"{row['id']}/{row['input_sha256']}"

    def upload(self, row: dict, data: bytes) -> None:
        response = self.storage.post(f"object/{BUCKET}/{self.object_key(row)}", content=data,
            headers={"Content-Type": row["input_mime"], "x-upsert": "false"})
        if response.status_code in (400, 409) and response.json().get("error") in ("Duplicate", "ResourceAlreadyExists"):
            existing = self.storage.get(f"object/{BUCKET}/{self.object_key(row)}")
            existing.raise_for_status()
            if existing.content == data:
                audio_cache.put(BUCKET, row, data)
                return
        response.raise_for_status()
        audio_cache.put(BUCKET, row, data)

    def read_audio(self, row: dict) -> bytes:
        local = audio_cache.get(BUCKET, row, row['input_sha256'])
        if local is not None:
            return local
        response = self.storage.get(f"object/{BUCKET}/{self.object_key(row)}")
        response.raise_for_status()
        if sha256(response.content).hexdigest() == row['input_sha256']:
            audio_cache.put(BUCKET, row, response.content)
        return response.content

    def remove_audio(self, row: dict) -> None:
        audio_cache.remove(BUCKET, row, row['input_sha256'])
        response = self.storage.request("DELETE", f"object/{BUCKET}", json={"prefixes": [self.object_key(row)]})
        response.raise_for_status()

    def cleanup_candidates(self, now: str) -> list[dict]:
        # Recheck terminal entries too: an upload that began before deletion may finish late.
        from datetime import datetime, timedelta
        recheck = (datetime.fromisoformat(now) - timedelta(hours=1)).isoformat()
        return self.database._request("GET", "/practice_analyses", params={
            "and": f"(or(input_expires_at.lt.{now},state.in.(completed,needs_review,deleted)),or(input_cleaned_at.is.null,input_cleaned_at.lt.{recheck}))",
            "select": "id,user_id,input_sha256,state", "order": "input_cleaned_at.asc.nullsfirst,created_at", "limit": "100"}).json()

    def mark_clean(self, row: dict, now: str) -> None:
        self.database._request("PATCH", "/practice_analyses", params={"id": f"eq.{row['id']}"},
            json={"input_cleaned_at": now, "input_ready": False})


@lru_cache
def get_practice_analysis_repository() -> PracticeAnalysisRepository | None:
    database = get_supabase_repository()
    settings = get_settings()
    return PracticeAnalysisRepository(database, settings.supabase_url or "", settings.supabase_secret_key or "") if database else None
