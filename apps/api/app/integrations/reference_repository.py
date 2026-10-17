"""Durable PostgreSQL queue; atomic leases need no second message-queue write."""
from functools import lru_cache
from hashlib import sha256

from app.integrations.practice_repository import PracticeRepository
from app.integrations.supabase_repository import get_supabase_repository
from app.config import get_settings
from app.services.acoustics import audio_cache

BUCKET = "reference-audio"


class ReferenceRepository(PracticeRepository):
    def recent_captures(self, owner: str, content: str, segment: str) -> list[dict]:
        from datetime import datetime, timezone
        return self.database._request('GET', '/acoustic_references', params={
            'user_id': f'eq.{owner}', 'content_id': f'eq.{content}', 'segment_id': f'eq.{segment}',
            'source_id': 'eq.browser_capture', 'state': 'neq.deleted',
            'expires_at': f'gt.{datetime.now(timezone.utc).isoformat()}',
            'order': 'created_at.desc', 'limit': '100', 'select': '*'}).json()

    def get(self, owner: str, reference: str) -> dict | None:
        rows = self.database._request("GET", "/acoustic_references", params={
            "id": f"eq.{reference}", "user_id": f"eq.{owner}", "select": "*", "limit": "1"}).json()
        return rows[0] if rows else None

    def create(self, row: dict) -> dict:
        self.database._request("POST", "/profiles", params={"on_conflict": "id"},
            headers={"Prefer": "resolution=ignore-duplicates"}, json={"id": row["user_id"]})
        rows = self.database._request("POST", "/acoustic_references", params={"on_conflict": "id"},
            headers={"Prefer": "resolution=ignore-duplicates,return=representation"}, json=row).json()
        return rows[0] if rows else self.get(row["user_id"], row["id"])

    def control(self, owner: str, reference: str, action: str, digest: str | None = None) -> dict | None:
        rows = self.database._request("POST", "/rpc/control_acoustic_reference", json={
            "p_id": reference, "p_owner": owner, "p_action": action, "p_hash": digest}).json()
        return rows[0] if rows else None

    def claim(self, token: str, seconds: int, lane: str = "fast") -> dict | None:
        rows = self.database._request("POST", "/rpc/claim_acoustic_reference_lane", json={"p_token": token, "p_seconds": seconds, "p_lane": lane}).json()
        return rows[0] if rows else None

    def fenced(self, reference: str, token: str, action: str, data: dict | None = None) -> bool:
        if action == "publish_handoff":
            return self.database._request("POST", "/rpc/publish_acoustic_handoff", json={
                "p_kind": "reference", "p_id": reference, "p_token": token, "p_data": data or {}}).json() is True
        if action == "handoff_fine":
            return self.database._request("POST", "/rpc/handoff_acoustic_job", json={
                "p_kind": "reference", "p_id": reference, "p_token": token}).json() is True
        return self.database._request("POST", "/rpc/update_acoustic_reference", json={
            "p_id": reference, "p_token": token, "p_action": action, "p_data": data or {}}).json() is True

    @staticmethod
    def object_key(row: dict) -> str:
        return f"{row['id']}/reference.wav"

    def upload(self, row: dict, data: bytes) -> None:
        response = self.storage.post(f"object/{BUCKET}/{self.object_key(row)}", content=data,
                                     headers={"Content-Type": "audio/wav", "x-upsert": "false"})
        if response.status_code in (400, 409) and response.json().get("error") in ("Duplicate", "ResourceAlreadyExists"):
            # An uncertain prior upload is safe only if bytes are identical.
            existing = self.storage.get(f"object/{BUCKET}/{self.object_key(row)}")
            existing.raise_for_status()
            if existing.content == data:
                audio_cache.put(BUCKET, row, data)
                return
        response.raise_for_status()
        audio_cache.put(BUCKET, row, data)

    def read_audio(self, row: dict) -> bytes:
        local = audio_cache.get(BUCKET, row, row.get('audio_sha256') or '')
        if local is not None:
            return local
        response = self.storage.get(f"object/{BUCKET}/{self.object_key(row)}")
        response.raise_for_status()
        if sha256(response.content).hexdigest() == row.get('audio_sha256'):
            audio_cache.put(BUCKET, row, response.content)
        return response.content

    def remove_audio(self, row: dict) -> None:
        audio_cache.remove(BUCKET, row, row.get('audio_sha256') or '')
        response = self.storage.request("DELETE", f"object/{BUCKET}", json={"prefixes": [self.object_key(row)]})
        response.raise_for_status()

    def cleanup_candidates(self, now: str, abandoned: str) -> list[dict]:
        from datetime import datetime, timedelta
        recheck = (datetime.fromisoformat(now) - timedelta(hours=1)).isoformat()
        return self.database._request("GET", "/acoustic_references", params={
            "or": f"(and(state.neq.deleted,expires_at.lt.{now}),and(state.eq.awaiting_upload,created_at.lt.{abandoned}),and(state.eq.deleted,or(cleanup_at.is.null,cleanup_at.lt.{recheck})))",
            "select": "*", "limit": "100", "order": "cleanup_at.asc.nullsfirst,created_at"}).json()

    def mark_clean(self, row: dict, now: str) -> None:
        self.database._request("PATCH", "/acoustic_references", params={
            "id": f"eq.{row['id']}", "state": "eq.deleted"}, json={"cleanup_at": now})


@lru_cache
def get_reference_repository() -> ReferenceRepository | None:
    database = get_supabase_repository()
    settings = get_settings()
    return ReferenceRepository(database, settings.supabase_url or "", settings.supabase_secret_key or "") if database else None
