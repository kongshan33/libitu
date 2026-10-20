"""Opt-in live teaching probe: isolated loopback API, real models and database.

Run from apps/api with --live --output /absolute/artifact/directory.
Only Clerk identity is replaced with a unique synthetic owner. The production
speaking router, runtime, models and repositories are unchanged. SIGINT exports
the complete diagnostic journal and removes the owned synthetic session/items.
"""
import argparse
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from app.auth import AuthenticatedUser, require_user
from app.config import get_settings
from app.routers import speaking
from app.schemas.corpus import CorpusItemCreate
from app.schemas.speaking import SpeakingSessionCreate
from app.services import corpus_service, speaking_diagnostics, speaking_runtime_state, speaking_service
from app.services.speaking_coaching_runtime import drain_diagnostics


def save(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path("/tmp/libitu-live-teaching-config.json"))
    args = parser.parse_args()
    if not args.live:
        parser.error("Pass --live to authorize real paid model calls and temporary database records.")
    settings = get_settings()
    if not (settings.gemini_api_key and settings.deepseek_api_key and settings.supabase_secret_key):
        parser.error("Gemini, DeepSeek and Supabase must all be configured.")
    if settings.speaking_realtime_provider != "gemini":
        parser.error("The configured speaking provider must be Gemini.")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    owner = "libitu-teaching-live-" + uuid4().hex
    item = session = None
    try:
        item = corpus_service.create_corpus_item(owner, CorpusItemCreate(
            kind="chunk", text="One trade-off is", meaning="Introduce a compromise between two choices",
            source_locator={"source_title": "Synthetic live teaching verification"},
        ))
        session = speaking_service.create_speaking_session(owner, SpeakingSessionCreate(
            client_id=uuid4(), scenario_type="workplace",
            goal="Choose a database for a small analytics product with a colleague, balancing reliability, cost and maintenance effort",
            corpus_item_ids=[item.id], difficulty="standard",
        ))
        config = {"sessionId": str(session.id), "owner": owner,
                  "uiOrigin": "http://localhost:3000", "apiOrigin": "http://127.0.0.1:8767",
                  "artifactDir": str(output), "commandPath": str(output / "commands.jsonl"),
                  "resultPath": str(output / "browser-results.jsonl"),
                  "models": {"gemini": settings.gemini_live_model, "deepseek": settings.deepseek_model},
                  "started_at": datetime.now(timezone.utc).isoformat()}
        save(output / "config.json", config)
        save(output / "session.json", session.model_dump(mode="json"))
        (output / "commands.jsonl").touch()
        save(args.config, config)

        @asynccontextmanager
        async def lifespan(_app):
            yield
            await drain_diagnostics()

        app = FastAPI(title="Isolated live teaching probe", lifespan=lifespan)
        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id=owner)
        app.add_middleware(CORSMiddleware, allow_origins=[config["uiOrigin"]],
                           allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
        app.include_router(speaking.router, prefix="/api/speaking")

        @app.get("/__test/ready")
        def ready() -> dict:
            return {"ready": True, "session_id": str(session.id), "models": config["models"]}

        print(json.dumps({"ready_config": str(args.config), "session_id": str(session.id),
                          "output": str(output), "models": config["models"]}), flush=True)
        uvicorn.run(app, host="127.0.0.1", port=8767, log_level="warning", access_log=False,
                    timeout_graceful_shutdown=20)
    finally:
        cleanup = {}
        if session:
            try:
                workspace = speaking_runtime_state.public_workspace(owner, str(session.id))
                save(output / "workspace.json", workspace.model_dump(mode="json"))
                events, before = [], None
                for _ in range(100):
                    page = speaking_diagnostics.read_events(owner, str(session.id), 200, before)
                    events.extend(page["events"])
                    before = page["next_before"]
                    if not before:
                        break
                events.sort(key=lambda event: (event["created_at"], event["id"]))
                save(output / "diagnostics.json", events)
            except Exception as error:
                cleanup["export_error_type"] = type(error).__name__
            try:
                speaking_runtime_state.delete_session(owner, str(session.id))
                cleanup["session_deleted"] = speaking_service.get_speaking_session(owner, str(session.id)) is None
            except Exception as error:
                cleanup["session_cleanup_error_type"] = type(error).__name__
        if item:
            try:
                corpus_service.delete_corpus_item(owner, str(item.id))
                cleanup["corpus_deleted"] = corpus_service.get_corpus_item(owner, str(item.id)) is None
            except Exception as error:
                cleanup["corpus_cleanup_error_type"] = type(error).__name__
        save(output / "cleanup.json", cleanup)
        print(json.dumps({"cleanup": cleanup}), flush=True)


if __name__ == "__main__":
    main()
