from functools import lru_cache
from hashlib import sha256
import json

import httpx
from pydantic import ValidationError

from app.config import get_settings
from app.schemas.blueprint import Blueprint
from app.schemas.captions import CaptionTrack
from app.schemas.content import ContentKind, ContentResolveResponse
from app.schemas.job import ProcessingJob
from app.schemas.corpus import CorpusItem, CorpusItemCreate, CorpusItemUpdate
from app.integrations.processing_queue import QueuedContent


_JOB_FIELDS = (
    "id,content_id,status,analysis_version,processing_stage,attempt_count,error_code,"
    "error_message,queued_at,started_at,completed_at,stage_timings_ms"
)


class SupabaseRepository:
    def __init__(self, url: str, secret_key: str) -> None:
        self._rest_url = f"{url.rstrip('/')}/rest/v1"
        self._headers = {
            "apikey": secret_key,
            "Content-Type": "application/json",
        }
        self._client = httpx.Client(
            base_url=self._rest_url,
            headers=self._headers,
            timeout=httpx.Timeout(10.0, connect=5.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )

    def save_content(
        self, content: ContentResolveResponse, transcript_text: str | None,
        caption_track: CaptionTrack | None = None,
    ) -> None:
        self._request(
            "POST",
            "/contents?on_conflict=id",
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            json={
                "id": content.content_id,
                "kind": content.kind.value,
                "visibility": "public",
                "owner_user_id": None,
                "normalized_key": content.normalized_key,
                "source_url": content.source_url,
                "title": content.title,
                "language": content.language,
                "metadata": {"has_transcript": bool(transcript_text)},
            },
        )
        if transcript_text:
            self.save_caption_source(content.content_id, transcript_text, caption_track)

    def save_caption_source(
        self, content_id: str, transcript_text: str, caption_track: CaptionTrack | None,
    ) -> None:
        """Update only the existing private payload, never public content metadata."""
        # YouTube has no article source_text. Store a typed source envelope in
        # that existing private field; never put captions or signed URLs in
        # public contents.metadata. Existing service-only RPCs remain unchanged.
        source_text = json.dumps({
            "type": "libitu-caption-source-v1",
            "caption_track": caption_track.model_dump(mode="json", exclude_none=True),
        }, ensure_ascii=False, separators=(",", ":")) if caption_track is not None else None
        self._request(
            "POST",
            "/rpc/upsert_content_payload",
            json={
                "p_content_id": content_id,
                "p_transcript_text": transcript_text,
                "p_source_text": source_text,
                "p_content_sha256": sha256((transcript_text + (source_text or "")).encode("utf-8")).hexdigest(),
            },
        )

    def get_content(self, content_id: str) -> QueuedContent | None:
        rows = self._request(
            "GET",
            f"/contents?id=eq.{content_id}&select=id,kind,normalized_key,source_url,title,language,metadata",
        ).json()
        if not rows:
            return None
        row = rows[0]
        payload_rows = self._request(
            "POST",
            "/rpc/get_content_payload",
            json={"p_content_id": content_id},
        ).json()
        transcript = payload_rows[0].get("transcript_text") if payload_rows else None
        caption_track = None
        if row["kind"] == ContentKind.youtube.value and payload_rows:
            try:
                source = json.loads(payload_rows[0].get("source_text") or "null")
                if isinstance(source, dict) and source.get("type") == "libitu-caption-source-v1":
                    candidate = CaptionTrack.model_validate(source.get("caption_track"))
                    if row["normalized_key"] == f"youtube:{candidate.video_id}":
                        caption_track = candidate
            except (ValueError, TypeError, ValidationError):
                # An absent/legacy source envelope must not prevent plain captions.
                pass
        return QueuedContent(
            content=ContentResolveResponse(
                content_id=row["id"],
                kind=ContentKind(row["kind"]),
                normalized_key=row["normalized_key"],
                source_url=row.get("source_url"),
                title=row.get("title"),
                language=row.get("language"),
                has_transcript=bool(transcript),
            ),
            transcript_text=transcript,
            caption_track=caption_track,
        )

    def save_job(self, job: ProcessingJob) -> None:
        payload = {
            "id": job.id,
            "content_id": job.content_id,
            "analysis_version": job.analysis_version,
            "status": job.status.value,
            "processing_stage": job.processing_stage.value,
            "attempt_count": job.attempt_count,
            "error_code": job.error_code,
            "error_message": job.error_message,
            "queued_at": job.queued_at.isoformat(),
            "started_at": job.started_at.isoformat() if job.started_at else None,
            "completed_at": job.completed_at.isoformat() if job.completed_at else None,
            "stage_timings_ms": job.stage_timings_ms,
        }
        self._request(
            "POST",
            "/processing_jobs?on_conflict=id",
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            json=payload,
        )

    def get_job(self, job_id: str) -> ProcessingJob | None:
        rows = self._request(
            "GET",
            f"/processing_jobs?id=eq.{job_id}&select={_JOB_FIELDS}",
        ).json()
        return ProcessingJob.model_validate(rows[0]) if rows else None

    def find_job(self, content_id: str, analysis_version: str) -> ProcessingJob | None:
        rows = self._request(
            "GET",
            f"/processing_jobs?content_id=eq.{content_id}&analysis_version=eq.{analysis_version}"
            f"&select={_JOB_FIELDS}&limit=1",
        ).json()
        return ProcessingJob.model_validate(rows[0]) if rows else None

    def save_blueprint(self, blueprint: Blueprint, analysis_version: str) -> None:
        self._request(
            "POST",
            "/blueprints?on_conflict=content_id,analysis_version",
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            json={
                "id": blueprint.id,
                "content_id": blueprint.content_id,
                "analysis_version": analysis_version,
                "summary": blueprint.summary,
                "logic_flow": [node.model_dump(mode="json") for node in blueprint.logic_flow],
                "key_points": blueprint.key_points,
                "scenario_suggestions": blueprint.scenario_suggestions,
                "document": blueprint.model_dump(mode="json"),
            },
        )

    def get_blueprint(self, content_id: str, analysis_version: str) -> Blueprint | None:
        rows = self._request(
            "GET",
            f"/blueprints?content_id=eq.{content_id}&analysis_version=eq.{analysis_version}"
            "&select=document&limit=1",
        ).json()
        if not rows:
            return None
        return Blueprint.model_validate(rows[0]["document"]).model_copy(
            update={"analysis_version": analysis_version}
        )

    def list_corpus_items(self, user_id: str) -> list[CorpusItem]:
        items: list[CorpusItem] = []
        while True:
            rows = self._request("GET", "/corpus_items", params={
                "user_id": f"eq.{user_id}", "select": "*", "order": "created_at.desc,id.desc",
                "limit": "1000", "offset": str(len(items)),
            }).json()
            items.extend(CorpusItem.model_validate(row) for row in rows)
            if len(rows) < 1000:
                return items

    def get_corpus_item(self, user_id: str, item_id: str) -> CorpusItem | None:
        rows = self._request("GET", "/corpus_items", params={
            "user_id": f"eq.{user_id}", "id": f"eq.{item_id}", "select": "*", "limit": "1",
        }).json()
        return CorpusItem.model_validate(rows[0]) if rows else None

    def create_corpus_item(self, user_id: str, item_id: str, payload: CorpusItemCreate) -> CorpusItem:
        if payload.content_id:
            rows = self._request("GET", "/contents", params={
                "id": f"eq.{payload.content_id}", "select": "visibility,owner_user_id", "limit": "1",
            }).json()
            if not rows or (rows[0]["visibility"] != "public" and rows[0]["owner_user_id"] != user_id):
                raise PermissionError("Source content is unavailable to this user.")
        self._request("POST", "/profiles", params={"on_conflict": "id"},
                      headers={"Prefer": "resolution=ignore-duplicates,return=minimal"}, json={"id": user_id})
        rows = self._request("POST", "/corpus_items", params={"on_conflict": "id"},
                             headers={"Prefer": "resolution=ignore-duplicates,return=representation"},
                             json={"id": item_id, "user_id": user_id, **payload.model_dump(mode="json", by_alias=True)}).json()
        # A repeated import must not overwrite a learner's edits in the cloud.
        item = CorpusItem.model_validate(rows[0]) if rows else self.get_corpus_item(user_id, item_id)
        if item is None or item.user_id != user_id:
            raise PermissionError("Corpus item is unavailable to this user.")
        if item.analysis_detail is None and payload.analysis_detail is not None:
            enriched = self.update_corpus_item(
                user_id,
                item_id,
                CorpusItemUpdate(analysis_detail=payload.analysis_detail),
            )
            if enriched is not None:
                return enriched
        return item

    def update_corpus_item(self, user_id: str, item_id: str, payload: CorpusItemUpdate) -> CorpusItem | None:
        rows = self._request("PATCH", "/corpus_items", params={
            "user_id": f"eq.{user_id}", "id": f"eq.{item_id}",
        }, headers={"Prefer": "return=representation"},
            json=payload.model_dump(mode="json", by_alias=True, exclude_unset=True)).json()
        return CorpusItem.model_validate(rows[0]) if rows else None

    def delete_corpus_item(self, user_id: str, item_id: str) -> bool:
        rows = self._request("DELETE", "/corpus_items", params={
            "user_id": f"eq.{user_id}", "id": f"eq.{item_id}",
        }, headers={"Prefer": "return=representation"}).json()
        return bool(rows)

    def _request(self, method: str, path: str, *, headers: dict | None = None, json: dict | None = None, params: dict | None = None):
        response = self._client.request(
            method,
            path,
            headers=headers,
            json=json,
            params=params,
        )
        response.raise_for_status()
        return response


@lru_cache
def get_supabase_repository() -> SupabaseRepository | None:
    settings = get_settings()
    if not settings.supabase_server_is_configured:
        return None
    return SupabaseRepository(settings.supabase_url or "", settings.supabase_secret_key or "")
