"""Opt-in API/database smoke check using isolated synthetic accounts.

Run from apps/api: .venv/bin/python scripts/verify_speaking_loadout.py --run-live
This checks real Supabase persistence with a test identity dependency, not Clerk login.
Only records belonging to the newly generated fixture accounts are removed.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations.supabase_repository import get_supabase_repository
from app.main import app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-live", action="store_true", required=True)
    parser.parse_args()
    database = get_supabase_repository()
    if database is None:
        raise SystemExit("Configure server Supabase access before running this check.")
    owner = f"loadout-smoke-{uuid4()}"
    other = f"loadout-smoke-{uuid4()}"
    client = TestClient(app)
    try:
        options = client.get("/api/speaking/options")
        assert options.status_code == 200
        assert len(options.json()["logic_templates"]) == 6
        assert client.post("/api/speaking/sessions", json={}).status_code == 401
        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=owner)
        ids = []
        for kind, text in [("idiom", "on the same page"), ("structure", "Given [premise], we should [action]")]:
            created = client.post("/api/corpus", json={
                "kind": kind, "text": text, "meaning": "Synthetic loadout fixture",
                "tags": ["acknowledging"], "source_locator": {"source_title": "Loadout verification"},
                "slots": {"premise": "shared context", "action": "next step"} if kind == "structure" else {},
            })
            assert created.status_code == 201, f"Corpus creation failed: {created.status_code}"
            ids.append(created.json()["id"])
        payload = {"client_id": str(uuid4()), "scenario_type": "workplace",
                   "goal": "Agree on a revised deadline", "difficulty": "guided",
                   "feedback_level": "detailed", "logic_template_id": "stakeholder_alignment",
                   "corpus_item_ids": ids}

        def submit():
            with TestClient(app) as concurrent_client:
                return concurrent_client.post("/api/speaking/sessions", json=payload)

        with ThreadPoolExecutor(max_workers=2) as pool:
            attempts = list(pool.map(lambda _: submit(), range(2)))
        assert all(response.status_code == 201 for response in attempts), "Concurrent session creation failed"
        session = attempts[0].json()
        assert session["id"] == attempts[1].json()["id"], "Retry created duplicate sessions"
        assert [item["kind"] for item in session["items"]] == ["idiom", "structure"]
        assert session["difficulty"] == "guided" and session["feedback_level"] == "detailed"
        assert session["logic_template"]["id"] == "stakeholder_alignment"
        path = f"/api/speaking/sessions/{session['id']}"
        assert client.get(path).json() == session
        assert client.post("/api/speaking/sessions", json={**payload, "goal": "Different goal"}).status_code == 409
        assert client.post("/api/speaking/sessions", json={**payload, "client_id": str(uuid4()), "corpus_item_ids": []}).status_code == 422

        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=other)
        assert client.get(path).status_code == 404
        assert client.post("/api/speaking/sessions", json={**payload, "client_id": str(uuid4())}).status_code == 404
        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=owner)
        assert client.patch(f"/api/corpus/{ids[0]}", json={"text": "Changed source"}).status_code == 200
        assert client.get(path).json()["items"][0]["text"] == "on the same page"
        assert client.delete(f"/api/corpus/{ids[0]}").status_code == 204
        recovered = client.get(path).json()
        assert recovered["items"][0]["text"] == "on the same page"
        assert recovered["items"][0]["corpus_item_id"] is None
        repeated = client.post("/api/speaking/sessions", json=payload)
        assert repeated.status_code == 201 and repeated.json()["id"] == session["id"]
        assert client.post(path + "/turns", json={"user_message": "A synthetic turn"}).status_code == 501
        print("PASS: real database create/read, concurrent idempotency, owner isolation, settings, idiom and immutable snapshots.")
    finally:
        app.dependency_overrides.clear()
        for account in [owner, other]:
            database._request("DELETE", "/profiles", params={"id": f"eq.{account}"})
        print("Synthetic loadout accounts and dependent records removed.")


if __name__ == "__main__":
    main()
