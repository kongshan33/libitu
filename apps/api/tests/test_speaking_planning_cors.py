from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.main import app
from app.routers import speaking


@pytest.mark.parametrize("trusted", [True, False])
def test_plan_error_categories_are_readable_only_by_allowed_web_origins(monkeypatch, trusted):
    allowed = next(
        row.kwargs["allow_origins"] for row in app.user_middleware if row.cls is CORSMiddleware
    )[0]
    origin = allowed if trusted else "https://untrusted.invalid"
    request_id = uuid4().hex

    async def failed(_owner, _payload):
        raise HTTPException(
            503,
            "AI could not prepare usable matching scenes. Your selection is kept; please retry.",
            headers={
                "X-Speaking-Plan-Error": "invalid_output_schema",
                "X-Speaking-Plan-Request-ID": request_id,
            },
        )

    monkeypatch.setattr(speaking, "create_speaking_plan", failed)
    previous = app.dependency_overrides.copy()
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="plan-cors-owner")
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/speaking/plans",
                headers={"Origin": origin},
                json={
                    "scenario_type": "workplace",
                    "targets": [{"corpus_item_id": str(uuid4()), "role": "primary"}],
                },
            )
        assert response.status_code == 503
        assert response.headers.get("access-control-allow-origin") == (origin if trusted else None)
        exposed = {
            value.strip().lower()
            for value in response.headers["access-control-expose-headers"].split(",")
        }
        assert exposed == {"x-speaking-plan-error", "x-speaking-plan-request-id", "x-request-id", "server-timing"}
        assert response.headers["X-Speaking-Plan-Error"] == "invalid_output_schema"
        assert response.headers["X-Speaking-Plan-Request-ID"] == request_id
        assert isinstance(response.json()["detail"], str)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
