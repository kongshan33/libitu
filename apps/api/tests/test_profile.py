from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import AuthenticatedUser, require_user
from app.integrations import profile_repository
from app.integrations.profile_repository import ProfileRecords, ProfileRepository
from app.main import app
from app.schemas.corpus import CorpusItem
from app.schemas.speaking import SpeakingSession
from app.services import profile_service, store

NOW = datetime(2026, 10, 2, 3, tzinfo=timezone.utc)
CONTENT_ID = "10000000-0000-0000-0000-000000000000"
SOURCE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def identity(index: int) -> str:
    return str(UUID(int=index))


def attempt(index: int, occurred: str = "2026-10-02T02:00:00Z", **changes) -> dict:
    return {"id": identity(index), "user_id": "alice", "content_id": CONTENT_ID,
            "sentence_id": "sentence-1", "sentence_text": "Let's talk this through.",
            "start_ms": 2500, "duration_ms": 5000, "created_at": occurred,
            "deleted_at": None, "contents": {"title": "Source title", "source_url": SOURCE_URL,
                                            "visibility": "public", "owner_user_id": None},
            **changes}


def session(index: int, *turn_dates: str, **changes) -> dict:
    return {"id": identity(index), "user_id": "alice", "goal": "Explain the next step",
            "created_at": "2026-09-01T00:00:00Z", "status": "active", "turn_count": 999,
            "scenario_type": "workplace", "difficulty": "standard",
            "speaking_runtime_state": {"messages": [
                {"role": "user", "status": "final", "text": "My next step is…", "created_at": created}
                for created in turn_dates]}, **changes}


def use_records(monkeypatch, records):
    monkeypatch.setattr(profile_service, "read_profile_records", lambda *args, **kwargs: records)


def test_activity_uses_actual_owner_records_and_final_turn_dates(monkeypatch):
    active = session(10, "2026-09-30T16:30:00Z", "2026-10-01T16:30:00Z")
    active["speaking_runtime_state"]["messages"] += [
        {"role": "assistant", "status": "final", "text": "Hi", "created_at": "2026-09-29T00:00:00Z"},
        {"role": "user", "status": "unavailable", "text": "missing", "created_at": "2026-09-28T00:00:00Z"},
        {"role": "user", "status": "final", "text": "  ", "created_at": "2026-09-27T00:00:00Z"},
    ]
    records = ProfileRecords(attempts=[attempt(1), attempt(2, "2026-09-29T18:00:00Z", duration_ms=8000),
        attempt(3, deleted_at="2026-10-02T01:00:00Z"), attempt(4, user_id="bob"),
        attempt(5, "2026-10-03T00:00:00Z")], sessions=[active, session(11), session(12, "2026-10-01T00:00:00Z", user_id="bob")],
        corpus=[{"id": identity(20), "user_id": "alice", "kind": "structure", "created_at": "2026-09-28T00:00:00Z"},
                {"id": identity(21), "user_id": "alice", "kind": "chunk", "created_at": "2026-09-27T00:00:00Z"},
                {"id": identity(22), "user_id": "bob", "kind": "chunk", "created_at": "2026-10-01T00:00:00Z"}])
    use_records(monkeypatch, records)
    result = profile_service.get_profile("alice", "Asia/Shanghai", "4w", now=NOW)
    assert result.overview.model_dump() == {"shadowing_attempts": 2, "speaking_sessions": 1,
        "corpus_total": 2, "corpus_structures": 1, "corpus_week_added": 1,
        "shadowing_duration_ms": 13000, "current_streak_days": 3, "active_days": 3}
    assert len(result.activity.items) == 28
    assert sum(bucket.speaking_turns for bucket in result.activity.items) == 2
    assert result.resume_speaking.session_id == UUID(identity(10))
    assert result.resume_speaking.turn_count == 2
    assert len(result.recent_history.items) == 3
    assert result.last_practiced_source.title == "Source title"
    assert result.last_practiced_source.source_url == SOURCE_URL
    assert result.recent_history.items[0].source_url == SOURCE_URL
    serialized = result.model_dump_json()
    assert "bob" not in serialized and "messages" not in serialized and "My next step" not in serialized
    # The same UTC timestamps fall on different calendar days west of UTC.
    west = profile_service.get_profile("alice", "America/Los_Angeles", "4w", now=NOW)
    assert west.overview.current_streak_days == 3
    assert west.activity.end_date.isoformat() == "2026-10-01"


def test_streak_allows_yesterday_but_breaks_after_a_missed_day(monkeypatch):
    records = ProfileRecords(attempts=[attempt(1, "2026-10-01T00:00:00Z"), attempt(2, "2026-09-30T00:00:00Z")])
    use_records(monkeypatch, records)
    assert profile_service.get_profile("alice", "UTC", "4w", now=NOW).overview.current_streak_days == 2
    assert profile_service.get_profile("alice", "UTC", "4w", now=NOW + timedelta(days=1)).overview.current_streak_days == 0


def test_dst_uses_calendar_dates_and_deduplicates_same_day(monkeypatch):
    use_records(monkeypatch, ProfileRecords(attempts=[
        attempt(1, "2026-11-01T05:30:00Z"), attempt(2, "2026-11-01T06:30:00Z"),
        attempt(3, "2026-10-31T12:00:00Z")]))
    result = profile_service.get_profile("alice", "America/New_York", "4w",
        now=datetime(2026, 11, 2, 12, tzinfo=timezone.utc))
    assert result.overview.current_streak_days == 2
    assert result.overview.active_days == 2


def test_calendar_ranges_unknown_corpus_dates_and_draft_resume(monkeypatch):
    use_records(monkeypatch, ProfileRecords(sessions=[session(9, status="draft")],
        corpus=[{"id": identity(1), "user_id": "alice", "kind": "chunk"}]))
    result = profile_service.get_profile("alice", "UTC", "3m", now=NOW)
    assert len(result.activity.items) == 90
    assert result.overview.corpus_week_added is None
    assert all(bucket.corpus_added is None for bucket in result.activity.items)
    assert result.resume_speaking.status == "draft"
    assert not result.recent_history.items
    assert result.overview.active_days == 0
    assert result.overview.speaking_sessions == 0
    use_records(monkeypatch, ProfileRecords(attempts=[attempt(1, "2026-08-01T00:00:00Z")]))
    all_time = profile_service.get_profile("alice", "UTC", "all", now=NOW)
    assert [bucket.date.isoformat() for bucket in all_time.activity.items] == ["2026-08-01", "2026-09-01", "2026-10-01"]
    assert all_time.activity.bucket == "month"


def test_history_paginates_stable_ties_and_excludes_drafts_and_deleted(monkeypatch):
    records = ProfileRecords(attempts=[attempt(index) for index in range(1, 8)] + [attempt(8, deleted_at="now")],
        sessions=[session(11), session(12, "2026-10-02T02:00:00Z", status="completed")])
    use_records(monkeypatch, records)
    first = profile_service.get_profile_history("alice", 0, 5)
    second = profile_service.get_profile_history("alice", first.next_offset, 5)
    assert [str(item.id) for item in first.items + second.items] == [identity(12), *[identity(i) for i in range(7, 0, -1)]]
    assert second.next_offset is None
    assert first.items[0].duration_ms is None
    assert profile_service.get_profile("alice", "UTC", "4w", now=NOW).recent_history.next_offset == 5


def test_unavailable_source_does_not_disclose_title_or_link(monkeypatch):
    use_records(monkeypatch, ProfileRecords(attempts=[attempt(1, contents={"title": "Private other account",
        "visibility": "private", "source_url": "https://private.example/secret", "owner_user_id": "bob"})]))
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert result.last_practiced_source is None
    assert result.recent_history.items[0].content_id is None
    assert result.recent_history.items[0].source_url is None
    assert "Private other account" not in result.model_dump_json()
    assert "private.example" not in result.model_dump_json()


def test_owned_private_source_url_is_available_and_legacy_missing_url_is_null(monkeypatch):
    row = attempt(1, contents={"title": "My private source", "source_url": SOURCE_URL,
                               "visibility": "private", "owner_user_id": "alice"})
    use_records(monkeypatch, ProfileRecords(attempts=[row]))
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert result.last_practiced_source.source_url == SOURCE_URL
    assert result.recent_history.items[0].source_url == SOURCE_URL
    row["contents"].pop("source_url")
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert result.last_practiced_source.source_url is None
    assert result.recent_history.items[0].source_url is None


class FakeDatabase:
    def __init__(self, rows, cap=2, *, exact=True):
        self.rows = rows
        self.cap = cap
        self.exact = exact
        self.calls = []

    def _request(self, method, table, *, params=None, headers=None, json=None):
        self.calls.append((method, table, {"params": params, "headers": headers, "json": json}))
        rows = [row for row in self.rows.get(table, []) if f"eq.{row['user_id']}" == params["user_id"]]
        if params.get("deleted_at") == "is.null":
            rows = [row for row in rows if not row.get("deleted_at")]
        offset = int(params["offset"])
        page = rows[offset:offset + self.cap]
        headers = {"content-range": f"{offset}-{offset + len(page) - 1}/{len(rows)}"} if self.exact else {}
        return httpx.Response(200, json=page, headers=headers)


@pytest.mark.parametrize("exact", [True, False])
def test_repository_reads_past_lower_server_caps_and_filters_every_table(exact):
    rows = [attempt(i) for i in range(1, 8)] + [attempt(8, user_id="bob"), attempt(9, deleted_at="now")]
    database = FakeDatabase({"/shadow_attempts": rows, "/speaking_sessions": [session(20)],
        "/corpus_items": [{"id": identity(30), "user_id": "alice", "kind": "chunk", "created_at": "2026-10-01T00:00:00Z"}]}, exact=exact)
    records = ProfileRepository(database).read("alice", NOW)
    assert len(records.attempts) == 7 and len(records.sessions) == 1 and len(records.corpus) == 1
    for method, table, kwargs in database.calls:
        assert method == "GET"
        assert kwargs["params"]["user_id"] == "eq.alice"
        assert kwargs["params"]["order"] == ("last_opened_at.desc,content_id.desc" if table == "/user_content_states" else "created_at.desc,id.desc")
        assert "*" not in kwargs["params"]["select"]
        assert "recording_sha256" not in kwargs["params"]["select"]
    attempt_offsets = [call[2]["params"]["offset"] for call in database.calls if call[1] == "/shadow_attempts"]
    assert attempt_offsets[:4] == ["0", "2", "4", "6"]


def test_repository_refuses_incomplete_changed_or_unbounded_totals(monkeypatch):
    database = FakeDatabase({"/shadow_attempts": [attempt(1), attempt(2), attempt(3)]})
    monkeypatch.setattr(profile_repository, "MAX_ROWS", 2)
    with pytest.raises(HTTPException) as error:
        ProfileRepository(database).read("alice", NOW)
    assert error.value.status_code == 503
    monkeypatch.setattr(profile_repository, "MAX_ROWS", 50)
    original = database._request
    def changing(*args, **kwargs):
        response = original(*args, **kwargs)
        if kwargs["params"]["offset"] != "0":
            response.headers["content-range"] = "2-2/4"
        return response
    monkeypatch.setattr(database, "_request", changing)
    with pytest.raises(HTTPException) as error:
        ProfileRepository(database).read("alice", NOW)
    assert error.value.status_code == 503


def test_repository_refuses_cross_owner_or_duplicate_rows():
    class BadDatabase:
        def __init__(self, values):
            self.values = values
        def _request(self, *args, **kwargs):
            return httpx.Response(200, json=self.values)
    for rows in ([attempt(1, user_id="bob")], [attempt(1), attempt(1)]):
        with pytest.raises(HTTPException) as error:
            ProfileRepository(BadDatabase(rows)).read("alice", NOW)
        assert error.value.status_code == 503


def test_inline_reads_existing_stores_without_fabricating_dates(monkeypatch):
    monkeypatch.setattr(store, "corpus_items", {identity(1): CorpusItem(id=identity(1), user_id="alice", kind="chunk", text="next step"),
        identity(2): CorpusItem(id=identity(2), user_id="bob", kind="chunk", text="secret")})
    mission = SpeakingSession(id=identity(3), user_id="alice", client_id=identity(4),
        scenario_type="workplace", goal="Plan", difficulty="standard", feedback_level="balanced",
        logic_template=None, created_at=NOW, items=[])
    monkeypatch.setattr(store, "speaking_sessions", {str(mission.id): mission})
    fake_runtime = SimpleNamespace(read=lambda owner, session_id: {"document": {"messages": []}})
    monkeypatch.setattr(profile_repository, "get_runtime_store", lambda: fake_runtime)
    records = profile_repository.read_profile_records("alice", NOW)
    assert len(records.corpus) == 1 and len(records.sessions) == 1 and not records.attempts
    assert records.corpus[0].get("created_at") is None


def test_endpoints_require_auth_validate_parameters_and_never_cache(monkeypatch):
    client = TestClient(app)
    assert client.get("/api/profile").status_code == 401
    assert client.get("/api/profile/history").status_code == 401
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="alice")
    try:
        use_records(monkeypatch, ProfileRecords())
        response = client.get("/api/profile?timezone=Asia/Shanghai&range=4w")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert response.json()["overview"]["shadowing_attempts"] == 0
        assert client.get("/api/profile?timezone=Not/AZone").status_code == 422
        assert client.get("/api/profile?range=1y").status_code == 422
        assert client.get("/api/profile/history?offset=-1").status_code == 422
        assert client.get("/api/profile/history?limit=51").status_code == 422
        history = client.get("/api/profile/history")
        assert history.json() == {"items": [], "next_offset": None}
        assert history.headers["cache-control"] == "private, no-store"
        def unavailable(*args, **kwargs):
            raise profile_repository.unavailable()
        monkeypatch.setattr(profile_service, "read_profile_records", unavailable)
        failure = client.get("/api/profile")
        assert failure.status_code == 503
        assert failure.headers["cache-control"] == "private, no-store"
        assert "overview" not in failure.json()
    finally:
        app.dependency_overrides.pop(require_user, None)


def test_repository_network_failure_is_sanitized_and_does_not_fallback(monkeypatch):
    class FailingDatabase:
        def _request(self, *args, **kwargs):
            raise httpx.ConnectError("sensitive infrastructure error")
    monkeypatch.setattr(profile_repository, "get_supabase_repository", lambda: FailingDatabase())
    with pytest.raises(HTTPException) as error:
        profile_repository.read_profile_records("alice", NOW)
    assert error.value.status_code == 503
    assert "sensitive" not in error.value.detail


def feedback(index: int, **changes) -> dict:
    from app.schemas.speaking_feedback import ANALYSIS_VERSION, RUBRIC_VERSION
    return {"id": identity(index + 100), "session_id": identity(index), "status": "ready",
            "rubric_version": RUBRIC_VERSION, "analysis_version": ANALYSIS_VERSION,
            "created_at": "2026-10-02T02:01:00Z", "updated_at": "2026-10-02T02:01:00Z",
            "dimensions": [{"id": key, "score": score,
                "basis": "coverage" if key == "transfer" else "ai_assessment", "summary": "Saved observation",
                "criteria": [{"evidence": [{"quote": "PRIVATE TRANSCRIPT"}]}]}
                for key, score in zip(("task_fit", "transfer", "scenario_fit", "naturalness"), (75, 50, 83, 0))],
            "source": {"messages": "PRIVATE SNAPSHOT"}, "lease_token": "PRIVATE TOKEN", **changes}


@pytest.mark.parametrize("relationship_list", [False, True])
def test_profile_projects_saved_report_only_and_preserves_scores(monkeypatch, relationship_list):
    report = feedback(11)
    own = session(11, "2026-10-02T02:00:00Z", status="completed",
                  speaking_feedback=[report] if relationship_list else report)
    foreign = session(12, "2026-10-02T02:30:00Z", user_id="bob", status="completed",
                      speaking_feedback=feedback(12))
    use_records(monkeypatch, ProfileRecords(sessions=[own, foreign]))
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    summary = result.latest_feedback
    assert summary.id == UUID(report["id"]) and summary.session_id == UUID(own["id"])
    assert summary.goal == own["goal"] and summary.difficulty == "standard"
    assert summary.scenario_type == "workplace" and summary.status == "ready"
    assert summary.practiced_at == datetime(2026, 10, 2, 2, tzinfo=timezone.utc)
    assert [dimension.score for dimension in summary.dimensions] == [75, 50, 83, 0]
    assert result.latest_feedback_unavailable_reason is None
    assert result.recent_history.items[0].feedback.available is True
    serialized = result.model_dump_json()
    assert not any(value in serialized for value in ("PRIVATE", "criteria", "lease_token", '"source"', "bob"))


def test_profile_keeps_partial_null_and_recency_uses_practice_not_retry(monkeypatch):
    partial = feedback(11, status="partial")
    partial["dimensions"][1]["score"] = None
    partial["updated_at"] = "2026-10-02T02:50:00Z"
    recent = feedback(12)
    use_records(monkeypatch, ProfileRecords(sessions=[
        session(11, "2026-10-01T02:00:00Z", status="completed", speaking_feedback=partial),
        session(12, "2026-10-02T02:00:00Z", status="completed", speaking_feedback=recent)]))
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert str(result.latest_feedback.session_id) == identity(12)
    use_records(monkeypatch, ProfileRecords(sessions=[
        session(11, "2026-10-01T02:00:00Z", status="completed", speaking_feedback=partial)]))
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert result.latest_feedback.status == "partial"
    assert result.latest_feedback.dimensions[1].score is None
    assert result.recent_history.items[0].feedback.available is True


@pytest.mark.parametrize("status", ["queued", "processing", "failed", "insufficient_data"])
def test_profile_does_not_present_retained_result_as_current_score(monkeypatch, status):
    use_records(monkeypatch, ProfileRecords(sessions=[session(11, "2026-10-02T02:00:00Z",
        status="completed", speaking_feedback=feedback(11, status=status))]))
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert result.latest_feedback is None and result.latest_feedback_unavailable_reason == "not_available"
    history = result.recent_history.items[0].feedback
    assert history.status == status and history.available is False and history.unavailable_reason is None


@pytest.mark.parametrize("mutation,reason", [
    (lambda value: value.update(rubric_version="future-rubric"), "version_mismatch"),
    (lambda value: value.update(analysis_version="future-analysis"), "version_mismatch"),
    (lambda value: value.update(rubric_version=None, analysis_version=None, dimensions=None,
                               task_fit=99, transfer=99, scenario_fit=99, naturalness=99), "legacy_report"),
    (lambda value: value.update(rubric_version=""), "legacy_report"),
    (lambda value: value.update(analysis_version=""), "legacy_report"),
    (lambda value: value.pop("rubric_version"), "legacy_report"),
    (lambda value: value.update(dimensions=None), "invalid_result"),
    (lambda value: value["dimensions"].pop(), "invalid_result"),
    (lambda value: value["dimensions"][0].update(id="transfer"), "invalid_result"),
    (lambda value: value["dimensions"][0].update(basis="coverage"), "invalid_result"),
    (lambda value: value["dimensions"][0].update(score=None), "invalid_result"),
    (lambda value: value["dimensions"][0].update(score=True), "invalid_result"),
    (lambda value: value["dimensions"][0].update(score="75"), "invalid_result"),
    (lambda value: value["dimensions"][0].update(score=101), "invalid_result"),
    (lambda value: value.update(created_at="not-a-date"), "invalid_result"),
    (lambda value: value.update(session_id=identity(999)), "invalid_result"),
    (lambda value: value.update(user_id="bob"), "invalid_result"),
])
def test_invalid_or_legacy_reports_abstain_explicitly(monkeypatch, mutation, reason):
    report = feedback(11)
    mutation(report)
    use_records(monkeypatch, ProfileRecords(sessions=[session(11, "2026-10-02T02:00:00Z",
        status="completed", speaking_feedback=report)]))
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert result.latest_feedback is None and result.latest_feedback_unavailable_reason == reason
    history = result.recent_history.items[0].feedback
    if history is not None:
        assert history.available is False and history.unavailable_reason == reason


def test_absent_reports_and_noncompleted_sessions_do_not_become_assessments(monkeypatch):
    use_records(monkeypatch, ProfileRecords(sessions=[
        session(11, "2026-10-02T02:00:00Z", status="completed"),
        session(12, "2026-10-02T02:00:00Z", status="active", speaking_feedback=feedback(12)),
        session(13, status="completed", speaking_feedback=feedback(13))]))
    result = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert result.latest_feedback is None and result.latest_feedback_unavailable_reason == "not_available"
    assert len(result.recent_history.items) == 2
    assert all(item.feedback is None for item in result.recent_history.items)


def test_profile_reads_feedback_in_one_bounded_owner_join():
    database = FakeDatabase({"/speaking_sessions": [session(11, "2026-10-02T02:00:00Z",
        status="completed", speaking_feedback=feedback(11))]})
    ProfileRepository(database).read("alice", NOW)
    calls = [call for call in database.calls if call[1] == "/speaking_sessions"]
    assert len(calls) == 1 and len(database.calls) == 4
    projection = calls[0][2]["params"]["select"].split("speaking_feedback(")[1]
    assert "dimensions:result->dimensions" in projection
    assert not any(value in projection for value in ("source", "lease", "messages", "input_hash", "*"))


def test_inline_profile_get_never_mutates_or_enqueues_feedback(monkeypatch):
    from copy import deepcopy
    from app.integrations.speaking_feedback_repository import InlineFeedbackStore
    from app.integrations.speaking_runtime_repository import InlineRuntimeStore

    runtime = InlineRuntimeStore()
    adapter = InlineFeedbackStore(runtime)
    mission = SpeakingSession(id=identity(11), user_id="alice", client_id=identity(40),
        scenario_type="workplace", goal="Plan", difficulty="standard", feedback_level="balanced",
        logic_template=None, created_at=NOW, items=[])
    monkeypatch.setattr(store, "speaking_sessions", {str(mission.id): mission})
    runtime.compare_and_swap("alice", str(mission.id), 0,
        {"messages": [{"role": "user", "status": "final", "text": "Let's plan the next step.",
                       "created_at": NOW.isoformat()}]}, "completed", 1)
    job = adapter.enqueue("alice", str(mission.id))
    adapter._jobs[str(mission.id)].update(status="ready", result={"dimensions": feedback(11)["dimensions"]})
    # A stale entry also must not be pruned by GET.
    adapter._jobs[identity(999)] = {**deepcopy(job), "session_id": identity(999)}
    before = deepcopy(adapter._jobs)
    monkeypatch.setattr(profile_repository, "_inline_feedback_store", adapter)
    monkeypatch.setattr(profile_repository, "get_runtime_store", lambda: runtime)
    def no_mutation(*args, **kwargs):
        pytest.fail("Profile GET must not perform assessment or job mutations")
    for name in ("enqueue", "claim", "complete", "pending_sessions", "_prune"):
        monkeypatch.setattr(adapter, name, no_mutation)
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="alice")
    try:
        client = TestClient(app)
        assert client.get("/api/profile").json()["latest_feedback"]["id"] == job["id"]
        assert client.get("/api/profile/history").json()["items"][0]["feedback"]["available"] is True
        assert adapter._jobs == before
        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="bob")
        assert client.get("/api/profile").json()["latest_feedback"] is None
        assert client.get("/api/profile/history").json()["items"] == []
    finally:
        app.dependency_overrides.pop(require_user, None)


def test_history_kind_filters_before_pagination_and_keeps_owner_boundary(monkeypatch):
    use_records(monkeypatch, ProfileRecords(
        attempts=[attempt(index, "2026-09-29T01:00:00Z") for index in range(1, 7)]
        + [attempt(99, user_id="bob")],
        sessions=[session(20 + index, "2026-09-30T01:00:00Z") for index in range(4)]
        + [session(90), session(91, "2026-09-30T01:00:00Z", user_id="bob")]))
    first = profile_service.get_profile_history("alice", 0, 4, "shadowing")
    second = profile_service.get_profile_history("alice", first.next_offset, 4, "shadowing")
    assert len(first.items) == 4 and len(second.items) == 2
    assert all(row.kind == "shadowing" for row in first.items + second.items)
    assert len({row.id for row in first.items + second.items}) == 6
    assert second.next_offset is None
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="alice")
    try:
        client = TestClient(app)
        missions = client.get("/api/profile/history?kind=speaking&limit=3").json()
        assert len(missions["items"]) == 3 and missions["next_offset"] == 3
        assert all(row["kind"] == "speaking" for row in missions["items"])
        assert client.get("/api/profile/history?kind=unknown").status_code == 422
    finally:
        app.dependency_overrides.pop(require_user, None)


def test_video_history_deduplicates_owned_sources_and_does_not_inflate_practice(monkeypatch):
    source = {"kind": "youtube", "title": "Original team update", "source_url": SOURCE_URL, "visibility": "public"}
    def video(index, stamp, **changes):
        return {"id": identity(index), "content_id": identity(index), "user_id": "alice", "last_opened_at": stamp, "contents": source, **changes}
    records = ProfileRecords(
        attempts=[attempt(1, contents=source)],
        corpus=[{"id": identity(2), "user_id": "alice", "kind": "chunk", "content_id": CONTENT_ID,
                 "created_at": "2026-10-01T00:00:00Z", "contents": source}],
        videos=[video(0, "2026-10-02T02:30:00Z", content_id=CONTENT_ID),
                video(3, "2026-10-02T01:00:00Z"),
                video(4, "2026-10-02T01:00:00Z", user_id="bob"),
                video(5, "2026-10-02T01:00:00Z", contents={**source, "visibility": "private", "owner_user_id": "bob"}),
                video(6, "2026-10-02T01:00:00Z", contents=None),
                video(7, "2030-01-01T00:00:00Z")])
    use_records(monkeypatch, records)
    summary = profile_service.get_profile("alice", "UTC", "4w", now=NOW)
    assert len(summary.recent_videos.items) == 2
    assert summary.recent_videos.items[0].id == UUID(CONTENT_ID)
    assert summary.recent_videos.items[0].title == "Original team update"
    assert summary.overview.shadowing_attempts == 1 and summary.overview.active_days == 1
    assert all(item.kind != "video" for item in summary.recent_history.items)
    first = profile_service.get_profile_history("alice", 0, 1, "video")
    second = profile_service.get_profile_history("alice", first.next_offset, 1, "video")
    assert first.items[0].kind == "video" and second.next_offset is None
    assert first.items[0].id != second.items[0].id


def test_record_video_is_authenticated_idempotent_and_does_not_start_processing(monkeypatch):
    from app.services import profile_visits
    from app.schemas.content import ContentResolveResponse
    monkeypatch.setattr(store, "content_visits", {})
    monkeypatch.setattr(store, "contents", {CONTENT_ID: ContentResolveResponse(
        content_id=CONTENT_ID, kind="youtube", normalized_key="youtube:dQw4w9WgXcQ", source_url=SOURCE_URL, title="Original video")})
    client = TestClient(app)
    path = f"/api/profile/videos/{CONTENT_ID}"
    assert client.put(path).status_code == 401
    app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="alice")
    try:
        for _ in range(2):
            response = client.put(path)
            assert response.status_code == 204 and response.headers["cache-control"] == "private, no-store"
        assert list(store.content_visits) == [("alice", CONTENT_ID)]
        assert client.put(f"/api/profile/videos/{identity(99)}").status_code == 404
        assert client.put("/api/profile/videos/invalid").status_code == 422
        assert len(client.get("/api/profile/history?kind=video").json()["items"]) == 1
        app.dependency_overrides[require_user] = lambda: AuthenticatedUser(id="bob")
        assert client.get("/api/profile/history?kind=video").json()["items"] == []
        # Persistence errors never fabricate an inline success.
        monkeypatch.setattr(profile_visits, "get_supabase_repository", lambda: SimpleNamespace(_request=lambda *a, **k: (_ for _ in ()).throw(httpx.ConnectError("private details"))))
        assert client.put(path).status_code == 503
        assert list(store.content_visits) == [("alice", CONTENT_ID)]
    finally:
        app.dependency_overrides.pop(require_user, None)


def test_video_upsert_preserves_existing_progress_and_checks_public_identity(monkeypatch):
    from app.services import profile_visits
    calls = []
    monkeypatch.setattr(profile_visits, "read_public_content", lambda content_id: calls.append(("identity", content_id)))
    database = SimpleNamespace(_request=lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(profile_visits, "get_supabase_repository", lambda: database)
    profile_visits.remember_video("alice", CONTENT_ID)
    assert calls[0] == ("identity", CONTENT_ID)
    args, kwargs = calls[-1]
    assert args == ("POST", "/user_content_states")
    assert set(kwargs["json"]) == {"user_id", "content_id", "last_opened_at"}
    assert kwargs["json"]["user_id"] == "alice"
    assert kwargs["params"]["on_conflict"] == "user_id,content_id"
