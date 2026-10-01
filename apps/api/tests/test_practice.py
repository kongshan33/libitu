from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations.practice_repository import PracticeRepository
from app.integrations.supabase_repository import SupabaseRepository
from app.main import app
from app.routers.practice import repository
from app.schemas.blueprint import Blueprint, TranscriptLine
from app.schemas.practice import MAX_RECORDING_BYTES
from app.services import practice_service

CONTENT = str(uuid4())
SENTENCE = "sentence-v2-test"
AUDIO = b"OggS" + b"test audio bytes"


class MemoryRepository:
    """Explicit test double; the application never falls back to this store."""
    def __init__(self):
        self.rows = {}
        self.audio = {}
        self.available = True
        self.fail_upload = False
        self.fail_remove = False
        self.on_upload = None

    def source_available(self, owner, content):
        return self.available and content == CONTENT

    def get(self, owner, attempt):
        row = self.rows.get(attempt)
        return deepcopy(row) if row and row["user_id"] == owner else None

    def create(self, row):
        self.rows.setdefault(row["id"], {**deepcopy(row), "created_at": datetime.now(timezone.utc).isoformat(), "deleted_at": None})
        return self.get(row["user_id"], row["id"])

    def list(self, owner, content, sentence, offset, limit):
        rows = [deepcopy(row) for row in self.rows.values() if row["user_id"] == owner
                and row["content_id"] == content and (sentence is None or row["sentence_id"] == sentence) and not row["deleted_at"]]
        return sorted(rows, key=lambda row: (row["created_at"], row["id"]), reverse=True)[offset:offset + limit]

    def update(self, owner, attempt, changes, *, pending_only=False):
        row = self.get(owner, attempt)
        if row is None or (pending_only and (row["recording_state"] != "pending" or row["deleted_at"])):
            return None
        self.rows[attempt].update(changes)
        return self.get(owner, attempt)

    def upload(self, row, data):
        if self.fail_upload:
            raise httpx.ConnectError("do not expose provider secrets")
        self.audio[row["id"]] = data
        if self.on_upload:
            self.on_upload(row)

    def read_audio(self, row):
        return self.audio[row["id"]]

    def remove_audio(self, row):
        if self.fail_remove:
            raise httpx.ConnectError("storage unavailable")
        self.audio.pop(row["id"], None)


def payload(retain=True):
    return {"client_id": str(uuid4()), "content_id": CONTENT, "sentence_id": SENTENCE,
            "duration_ms": 2300, "playback_rate": 1, "text_visible": True,
            "recording": {"consent_version": "recording-retention-v1", "sha256": sha256(AUDIO).hexdigest(),
                          "size": len(AUDIO), "mime_type": "audio/ogg"} if retain else None}


@pytest.fixture
def setup(monkeypatch):
    repo = MemoryRepository()
    app.dependency_overrides[repository] = lambda: repo
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="user-a")
    blueprint = Blueprint(id=str(uuid4()), content_id=CONTENT, title="Practice", summary="", logic_flow=[],
                          key_points=[], scenario_suggestions=[], transcript=[])
    sentence = TranscriptLine(id=SENTENCE, segmentation_version="sentence-v2", time="0:00", parts=["Hello there."],
                              source_token_start=0, source_token_end=2, start_ms=0, end_ms=3000)
    monkeypatch.setattr(practice_service, "get_blueprint", lambda content: blueprint)
    monkeypatch.setattr(practice_service, "find_blueprint_sentence", lambda bp, sentence_id: sentence if sentence_id == SENTENCE else None)
    yield TestClient(app), repo
    app.dependency_overrides.clear()


def create(client, data=None):
    response = client.post("/api/practice/attempts", json=data or payload())
    assert response.status_code == 201, response.text
    return response.json()


def test_record_upload_refresh_replay_and_recording_only_delete(setup):
    client, repo = setup
    first = create(client)
    path = f"/api/practice/attempts/{first['id']}/recording"
    assert first["sentence_text"] == "Hello there."
    assert "user_id" not in first and "recording_sha256" not in first
    assert client.get(path).status_code == 404
    for _ in range(2):
        assert client.put(path, content=AUDIO, headers={"Content-Type": "audio/ogg"}).json()["recording_state"] == "ready"
    response = client.get(path)
    assert response.content == AUDIO and response.headers["cache-control"] == "private, no-store"
    history = client.get("/api/practice/attempts", params={"content_id": CONTENT, "sentence_id": SENTENCE}).json()
    assert history["items"][0]["recording_state"] == "ready"
    assert client.delete(path).status_code == 204
    assert client.get(path).status_code == 404
    assert client.put(path, content=AUDIO, headers={"Content-Type": "audio/ogg"}).status_code == 409
    assert repo.rows[first["id"]]["sentence_text"] == "Hello there." and not repo.audio


def test_required_auth_and_no_memory_fallback(setup, monkeypatch):
    client, _ = setup
    app.dependency_overrides.pop(require_user)
    assert client.post("/api/practice/attempts", json=payload()).status_code == 401
    assert client.get("/api/practice/attempts", params={"content_id": CONTENT}).status_code == 401
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="user-a")
    app.dependency_overrides.pop(repository)
    monkeypatch.setattr("app.routers.practice.get_practice_repository", lambda: None)
    assert client.post("/api/practice/attempts", json=payload()).status_code == 503


def test_every_recording_route_rejects_other_owner(setup):
    client, repo = setup
    row = create(client)
    path = f"/api/practice/attempts/{row['id']}"
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="user-b")
    assert client.get(f"{path}/recording").status_code == 404
    assert client.put(f"{path}/recording", content=AUDIO).status_code == 404
    assert client.delete(f"{path}/recording").status_code == 404
    assert client.delete(path).status_code == 404
    assert client.get("/api/practice/attempts", params={"content_id": CONTENT}).json()["items"] == []
    assert repo.rows[row["id"]]["recording_state"] == "pending"


def test_idempotency_is_owner_bound_and_rejects_changed_payload(setup):
    client, repo = setup
    data = payload()
    first = create(client, data)
    assert create(client, data)["id"] == first["id"]
    assert len(repo.rows) == 1
    assert client.post("/api/practice/attempts", json={**data, "duration_ms": 1000}).status_code == 409
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="user-b")
    assert create(client, data)["id"] != first["id"]


def test_no_consent_means_no_upload_and_unknown_fields_rejected(setup):
    client, _ = setup
    row = create(client, payload(False))
    assert row["recording_state"] == "none"
    assert client.put(f"/api/practice/attempts/{row['id']}/recording", content=AUDIO).status_code == 409
    for extra in ({"user_id": "other"}, {"sentence_text": "forged"}, {"score": 100}):
        assert client.post("/api/practice/attempts", json={**payload(), **extra}).status_code == 422


def test_source_access_and_sentence_validation(setup):
    client, repo = setup
    repo.available = False
    assert client.post("/api/practice/attempts", json=payload()).status_code == 404
    repo.available = True
    assert client.post("/api/practice/attempts", json={**payload(), "sentence_id": "forged"}).status_code == 409
    assert not repo.rows


def test_upload_limits_hash_and_container_checks(setup):
    client, _ = setup
    first = create(client)
    path = f"/api/practice/attempts/{first['id']}/recording"
    assert client.put(path, content=AUDIO, headers={"Content-Type": "audio/mp4"}).status_code == 422
    assert client.put(path, content=b"changed", headers={"Content-Type": "audio/ogg"}).status_code == 422
    assert client.put(path, content=b"x" * (MAX_RECORDING_BYTES + 1)).status_code == 413
    data = payload()
    data["recording"]["sha256"] = sha256(b"not audio").hexdigest()
    data["recording"]["size"] = len(b"not audio")
    other = create(client, data)
    assert client.put(f"/api/practice/attempts/{other['id']}/recording", content=b"not audio", headers={"Content-Type": "audio/ogg"}).status_code == 415


def test_delete_tombstone_prevents_late_create_and_inflight_upload(setup):
    client, repo = setup
    data = payload()
    first = create(client, data)
    path = f"/api/practice/attempts/{first['id']}"
    repo.on_upload = lambda row: practice_service.delete_recording(repo, row["user_id"], row["id"], entire_attempt=True)
    assert client.put(path + "/recording", content=AUDIO, headers={"Content-Type": "audio/ogg"}).status_code == 409
    assert not repo.audio
    assert client.post("/api/practice/attempts", json=data).status_code == 409
    assert client.delete(path).status_code == 204
    assert repo.rows[first["id"]]["sentence_text"] == ""


def test_provider_failures_are_retryable_and_safe(setup, monkeypatch):
    client, repo = setup
    app.dependency_overrides.pop(repository)
    monkeypatch.setattr("app.routers.practice.get_practice_repository", lambda: repo)
    first = create(client)
    path = f"/api/practice/attempts/{first['id']}/recording"
    repo.fail_upload = True
    result = client.put(path, content=AUDIO, headers={"Content-Type": "audio/ogg"})
    assert result.status_code == 503 and "secret" not in result.text
    assert repo.rows[first["id"]]["recording_state"] == "pending"
    repo.fail_upload = False
    assert client.put(path, content=AUDIO, headers={"Content-Type": "audio/ogg"}).status_code == 200
    repo.fail_remove = True
    assert client.delete(path).status_code == 503
    assert client.get(path).status_code == 404
    repo.fail_remove = False
    assert client.delete(path).status_code == 204 and not repo.audio


def test_history_pagination(setup):
    client, _ = setup
    for _ in range(3):
        create(client, payload(False))
    page = client.get("/api/practice/attempts", params={"content_id": CONTENT, "limit": 2}).json()
    assert len(page["items"]) == 2 and page["next_offset"] == 2
    last = client.get("/api/practice/attempts", params={"content_id": CONTENT, "limit": 2, "offset": 2}).json()
    assert len(last["items"]) == 1 and last["next_offset"] is None


def test_real_repository_filters_owner_and_uses_conditional_finalize():
    calls = []
    def respond(request):
        calls.append(request)
        assert request.url.params["user_id"] == "eq.user-a"
        if request.method == "PATCH":
            assert request.url.params["recording_state"] == "eq.pending"
            assert request.url.params["deleted_at"] == "is.null"
        return httpx.Response(200, json=[])
    database = SupabaseRepository("https://test.invalid", "test")
    database._client.close()
    database._client = httpx.Client(base_url="https://test.invalid/rest/v1", transport=httpx.MockTransport(respond))
    repo = PracticeRepository(database, "https://test.invalid", "test")
    try:
        assert repo.get("user-a", str(uuid4())) is None
        assert repo.list("user-a", CONTENT, SENTENCE, 0, 20) == []
        assert repo.update("user-a", str(uuid4()), {"recording_state": "ready"}, pending_only=True) is None
        assert len(calls) == 3
    finally:
        database._client.close(); repo.storage.close()
