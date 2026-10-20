"""Versioned, owner-scoped runtime documents. All methods are synchronous."""

import json
from threading import RLock
from typing import Protocol
from uuid import UUID

import httpx
from fastapi import HTTPException

from app.config import get_settings
from app.integrations.supabase_repository import SupabaseRepository, get_supabase_repository
from app.services import store

MAX_DOCUMENT_BYTES = 1024 * 1024
MAX_VERSION = 9007199254740991  # Public versions must remain exact JavaScript integers.
_STATUSES = {"draft", "active", "completed", "abandoned"}
_TERMINAL = {"completed", "abandoned"}


class RuntimeConflict(Exception):
    """A competing write or terminal session invalidated this mutation."""


class RuntimeStore(Protocol):
    def read(self, owner: str, session_id: str) -> dict | None: ...

    def compare_and_swap(
        self, owner: str, session_id: str, expected_version: int,
        document: dict, status: str, turn_count: int,
    ) -> dict | None: ...

    def delete(self, owner: str, session_id: str) -> bool: ...


def _invalid() -> HTTPException:
    return HTTPException(status_code=422, detail="Invalid speaking runtime state.")


def _unavailable() -> HTTPException:
    return HTTPException(status_code=503, detail="Speaking persistence is unavailable. Please retry.")


def _identity(owner: str, session_id: str) -> str:
    if not isinstance(owner, str) or not owner.strip():
        raise _invalid()
    try:
        return str(UUID(str(session_id)))
    except (TypeError, ValueError, AttributeError):
        raise _invalid() from None


def _json_value(value: object) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise _invalid()
            _json_value(key)
            _json_value(item)
    elif isinstance(value, list):
        for item in value:
            _json_value(item)
    elif isinstance(value, str):
        # PostgreSQL jsonb cannot represent NUL or invalid Unicode surrogates.
        if "\x00" in value:
            raise _invalid()
    elif value is not None and type(value) not in (bool, int, float):
        raise _invalid()


def _document(document: dict) -> dict:
    if not isinstance(document, dict):
        raise _invalid()
    try:
        _json_value(document)
        encoded = json.dumps(document, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_DOCUMENT_BYTES:
            raise _invalid()
        return json.loads(encoded)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise _invalid() from None


def _mutation(expected_version: int, document: dict, status: str, turn_count: int) -> dict:
    if (type(expected_version) is not int or not 0 <= expected_version < MAX_VERSION
            or not isinstance(status, str) or status not in _STATUSES
            or type(turn_count) is not int or not 0 <= turn_count <= 2147483647):
        raise _invalid()
    return _document(document)


def _envelope(value: object) -> dict | None:
    if value is None:
        return None
    if (not isinstance(value, dict)
            or type(value.get("version")) is not int or not 0 <= value["version"] <= MAX_VERSION
            or not isinstance(value.get("status"), str) or value["status"] not in _STATUSES
            or type(value.get("turn_count")) is not int or value["turn_count"] < 0):
        raise _unavailable()
    try:
        document = _document(value.get("document"))
    except HTTPException:
        raise _unavailable() from None
    return {"version": value["version"], "document": document,
            "status": value["status"], "turn_count": value["turn_count"]}


class SupabaseRuntimeStore:
    def __init__(self, database: SupabaseRepository) -> None:
        self.database = database

    def _rpc(self, name: str, payload: dict):
        try:
            return self.database._request("POST", f"/rpc/{name}", json=payload).json()
        except httpx.HTTPStatusError as exc:
            # Trust only our explicit SQLSTATE codes; never expose database/provider text.
            try:
                error = exc.response.json()
                code = error.get("code") if isinstance(error, dict) else None
            except ValueError:
                code = None
            if code == "PT409":
                raise RuntimeConflict("Speaking runtime changed. Please retry.") from None
            if code == "PT422":
                raise _invalid() from None
            raise _unavailable() from None
        except (httpx.RequestError, ValueError, TypeError):
            raise _unavailable() from None

    def read(self, owner: str, session_id: str) -> dict | None:
        session_id = _identity(owner, session_id)
        return _envelope(self._rpc("read_speaking_runtime", {
            "p_user_id": owner, "p_session_id": session_id,
        }))

    def compare_and_swap(
        self, owner: str, session_id: str, expected_version: int,
        document: dict, status: str, turn_count: int,
    ) -> dict | None:
        session_id = _identity(owner, session_id)
        document = _mutation(expected_version, document, status, turn_count)
        return _envelope(self._rpc("cas_speaking_runtime", {
            "p_user_id": owner, "p_session_id": session_id,
            "p_expected_version": expected_version, "p_document": document,
            "p_status": status, "p_turn_count": turn_count,
        }))

    def delete(self, owner: str, session_id: str) -> bool:
        session_id = _identity(owner, session_id)
        deleted = self._rpc("delete_speaking_runtime", {
            "p_user_id": owner, "p_session_id": session_id,
        })
        if type(deleted) is not bool:
            raise _unavailable()
        return deleted


class InlineRuntimeStore:
    """Explicit local fixture with the same version and ownership semantics."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._documents: dict[str, dict] = {}

    def _read(self, owner: str, session_id: str) -> dict | None:
        session = store.speaking_sessions.get(session_id)
        if session is None or session.user_id != owner:
            return None
        state = self._documents.get(session_id, {"version": 0, "document": {}})
        return {**state, "status": session.status, "turn_count": session.turn_count}

    def read(self, owner: str, session_id: str) -> dict | None:
        session_id = _identity(owner, session_id)
        with self._lock:
            return _envelope(self._read(owner, session_id))

    def compare_and_swap(
        self, owner: str, session_id: str, expected_version: int,
        document: dict, status: str, turn_count: int,
    ) -> dict | None:
        session_id = _identity(owner, session_id)
        document = _mutation(expected_version, document, status, turn_count)
        with self._lock:
            previous = self._read(owner, session_id)
            if previous is None:
                return None
            if (previous["version"] != expected_version
                    or previous["status"] in _TERMINAL and status != previous["status"]):
                raise RuntimeConflict("Speaking runtime changed. Please retry.")
            self._documents[session_id] = {"version": expected_version + 1, "document": document}
            store.speaking_sessions[session_id] = store.speaking_sessions[session_id].model_copy(
                update={"status": status, "turn_count": turn_count},
            )
            return _envelope(self._read(owner, session_id))

    def delete(self, owner: str, session_id: str) -> bool:
        session_id = _identity(owner, session_id)
        with self._lock:
            if self._read(owner, session_id) is None:
                return False
            del store.speaking_sessions[session_id]
            self._documents.pop(session_id, None)
            from app.integrations.speaking_diagnostics_repository import purge_inline_diagnostics

            purge_inline_diagnostics(session_id)
            return True


_inline_runtime_store = InlineRuntimeStore()


def get_runtime_store() -> RuntimeStore:
    try:
        database = get_supabase_repository()
    except (httpx.HTTPError, ValueError):
        raise _unavailable() from None
    if database is not None:
        return SupabaseRuntimeStore(database)
    settings = get_settings()
    if settings.supabase_server_is_configured or settings.processing_mode != "inline":
        raise _unavailable()
    return _inline_runtime_store
