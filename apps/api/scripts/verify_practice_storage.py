"""Opt-in live smoke test. Uses synthesized sound and removes only its own fixtures.

Run from apps/api: .venv/bin/python scripts/verify_practice_storage.py --run-live
This verifies Supabase IO and API ownership, not a real Clerk login or speech quality.
"""
import argparse
from hashlib import sha256
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations.practice_repository import get_practice_repository
from app.main import app
from app.schemas.blueprint import Blueprint, TranscriptLine


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-live", action="store_true", required=True)
    parser.parse_args()
    repo = get_practice_repository()
    if repo is None:
        raise SystemExit("Configure server Supabase access before running this check.")
    fixture_id = str(uuid4())
    owner = f"practice-smoke-{fixture_id}"
    audio = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
                            "-c:a", "libopus", "-f", "ogg", "pipe:1"], check=True, capture_output=True).stdout
    sentence = TranscriptLine(id="sentence-v2-smoke", time="0:00", parts=["Synthetic practice fixture."],
                              segmentation_version="sentence-v2", source_token_start=0, source_token_end=3,
                              start_ms=0, end_ms=1000)
    blueprint = Blueprint(id=str(uuid4()), content_id=fixture_id, title="Synthetic storage verification",
                          summary="", logic_flow=[], key_points=[], scenario_suggestions=[], transcript=[sentence])
    client = TestClient(app)
    row = None
    try:
        repo.database._request("POST", "/contents", json={"id": fixture_id, "kind": "youtube", "visibility": "public",
            "normalized_key": f"practice-smoke:{fixture_id}", "title": "Synthetic storage verification", "language": "en"})
        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=owner)
        payload = {"client_id": str(uuid4()), "content_id": fixture_id, "sentence_id": sentence.id,
                   "duration_ms": 500, "playback_rate": 1, "text_visible": True,
                   "recording": {"consent_version": "recording-retention-v1", "sha256": sha256(audio).hexdigest(),
                                 "size": len(audio), "mime_type": "audio/ogg"}}
        with patch("app.services.practice_service.get_blueprint", return_value=blueprint), \
             patch("app.services.practice_service.find_blueprint_sentence", return_value=sentence):
            created = client.post("/api/practice/attempts", json=payload)
            assert created.status_code == 201, f"Create failed: {created.status_code}"
            row = repo.get(owner, created.json()["id"])
            repeated = client.post("/api/practice/attempts", json=payload)
            assert repeated.json()["id"] == row["id"]
        path = f"/api/practice/attempts/{row['id']}/recording"
        for _ in range(2):
            result = client.put(path, content=audio, headers={"Content-Type": "audio/ogg"})
            assert result.status_code == 200, f"Upload failed: {result.status_code}"
        assert client.get(path).content == audio
        # Exercise an uncertain-upload retry while the row is still pending.
        repo.update(owner, row["id"], {"recording_state": "pending"})
        assert client.put(path, content=audio, headers={"Content-Type": "audio/ogg"}).status_code == 200
        history = client.get("/api/practice/attempts", params={"content_id": fixture_id}).json()
        assert len(history["items"]) == 1 and history["items"][0]["recording_state"] == "ready"
        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="other-practice-smoke-user")
        assert client.get(path).status_code == 404
        assert client.delete(path).status_code == 404
        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=owner)
        assert client.delete(path).status_code == 204
        assert client.get(path).status_code == 404
        assert client.delete(f"/api/practice/attempts/{row['id']}").status_code == 204
        print("PASS: durable create, idempotent retry, private upload/replay, history, owner isolation and deletion.")
    finally:
        app.dependency_overrides.clear()
        if row:
            repo.remove_audio(row)
        repo.database._request("DELETE", "/shadow_attempts", params={"user_id": f"eq.{owner}", "content_id": f"eq.{fixture_id}"})
        repo.database._request("DELETE", "/contents", params={"id": f"eq.{fixture_id}"})
        repo.database._request("DELETE", "/profiles", params={"id": f"eq.{owner}"})
        print("Synthetic fixtures removed.")


if __name__ == "__main__":
    main()
