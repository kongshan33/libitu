"""Aggregate recorded practice, not estimates of proficiency or idle time."""

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from uuid import UUID

from fastapi import HTTPException

from app.integrations.profile_repository import ProfileRecords, read_profile_records, unavailable
from app.schemas.profile import (
    ActivityBucket, LastPracticedSource, LearningProfile, ProfileActivity, ProfileHistoryItem,
    ProfileHistoryPage, ProfileOverview, ProfileRange, ResumeSpeaking, ProfileFeedbackDimension,
    ProfileFeedbackSummary, ProfileHistoryFeedback, ProfileHistoryKind,
)
from app.schemas.speaking_feedback import ANALYSIS_VERSION, RUBRIC_VERSION

_DIMENSIONS = ("task_fit", "transfer", "scenario_fit", "naturalness")
_FEEDBACK_STATUSES = {"queued", "processing", "ready", "partial", "insufficient_data", "failed"}


def _date_time(value: str | datetime) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if not isinstance(parsed, datetime) or parsed.tzinfo is None:
        raise ValueError("Activity requires an absolute timestamp")
    return parsed.astimezone(timezone.utc)


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(422, "Use a valid IANA timezone.",
                            headers={"Cache-Control": "private, no-store"}) from None


def _messages(row: dict) -> list[dict]:
    runtime = row.get("speaking_runtime_state") or {}
    # Accept both PostgREST relationship encodings for a unique child row.
    if isinstance(runtime, list):
        if len(runtime) > 1:
            raise ValueError("Multiple runtime records")
        runtime = runtime[0] if runtime else {}
    messages = runtime.get("messages") or []
    if not isinstance(messages, list):
        raise ValueError("Invalid conversation messages")
    return [message for message in messages if message.get("role") == "user"
            and message.get("status") == "final" and message.get("text", "").strip()]


def _practice_data(records: ProfileRecords, owner: str, now: datetime):
    attempts = [row for row in records.attempts if row.get("user_id") == owner
                and not row.get("deleted_at") and _date_time(row["created_at"]) <= now]
    sessions = []
    for row in records.sessions:
        if row.get("user_id") != owner or _date_time(row["created_at"]) > now:
            continue
        turns = [_date_time(message["created_at"]) for message in _messages(row)]
        turns = [turn for turn in turns if turn <= now]
        sessions.append((row, turns))
    return attempts, sessions


def _source_visible(row: dict, owner: str) -> bool:
    source = row.get("contents")
    return isinstance(source, dict) and (source.get("visibility") == "public"
                                        or source.get("owner_user_id") == owner)


def _feedback(row: dict, turns: list[datetime]):
    """Validate only saved summary fields, never infer scores from legacy columns."""
    if row["status"] != "completed" or not turns:
        return None, None, None
    report = row.get("speaking_feedback")
    if isinstance(report, list):
        if len(report) > 1:
            return None, None, "invalid_result"
        report = report[0] if report else None
    if report is None:
        return None, None, None
    history = None
    try:
        if (not isinstance(report, dict) or report.get("status") not in _FEEDBACK_STATUSES
                or UUID(report["session_id"]) != UUID(row["id"])
                or report.get("user_id", row["user_id"]) != row["user_id"]):
            raise ValueError("Feedback does not match its completed owner session")
        history = ProfileHistoryFeedback(id=report["id"], status=report["status"], available=False)
        if not report.get("rubric_version") or not report.get("analysis_version"):
            history.unavailable_reason = "legacy_report"
            return history, None, "legacy_report"
        if report.get("rubric_version") != RUBRIC_VERSION or report.get("analysis_version") != ANALYSIS_VERSION:
            history.unavailable_reason = "version_mismatch"
            return history, None, "version_mismatch"
        if report["status"] not in {"ready", "partial"}:
            return history, None, None
        raw_dimensions = report.get("dimensions")
        if not isinstance(raw_dimensions, list) or len(raw_dimensions) != len(_DIMENSIONS):
            raise ValueError("All four dimensions must be explicitly represented")
        dimensions = [ProfileFeedbackDimension.model_validate(value) for value in raw_dimensions]
        if {dimension.id for dimension in dimensions} != set(_DIMENSIONS):
            raise ValueError("Dimension IDs must be complete and unique")
        if any(dimension.basis != ("coverage" if dimension.id == "transfer" else "ai_assessment")
               for dimension in dimensions):
            raise ValueError("The dimension basis does not match the current rubric")
        if report["status"] == "ready" and any(dimension.score is None for dimension in dimensions):
            raise ValueError("A ready result cannot have missing dimension scores")
        created, updated = _date_time(report["created_at"]), _date_time(report["updated_at"])
        if updated < created:
            raise ValueError("Invalid report dates")
        summary = ProfileFeedbackSummary(
            id=history.id, session_id=row["id"], status=report["status"],
            rubric_version=report["rubric_version"], analysis_version=report["analysis_version"],
            goal=row["goal"], scenario_type=row["scenario_type"], difficulty=row["difficulty"],
            created_at=created, updated_at=updated, practiced_at=max(turns),
            dimensions=sorted(dimensions, key=lambda dimension: _DIMENSIONS.index(dimension.id)),
        )
        history.available = True
        return history, summary, None
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
        if history is not None:
            history.unavailable_reason = "invalid_result"
        return history, None, "invalid_result"


def _latest_feedback(sessions: list[tuple[dict, list[datetime]]]):
    candidates = sorted(((row, turns) for row, turns in sessions if turns),
                        key=lambda value: (max(value[1]), value[0]["id"]), reverse=True)
    first_reason = None
    for row, turns in candidates:
        _, summary, reason = _feedback(row, turns)
        if summary is not None:
            return summary, None
        first_reason = first_reason or reason
    return None, first_reason or "not_available"


def _history(attempts: list[dict], sessions: list[tuple[dict, list[datetime]]], owner: str,
             offset: int, limit: int, kind: ProfileHistoryKind = "all") -> ProfileHistoryPage:
    items = [ProfileHistoryItem(
        id=row["id"], kind="shadowing", title=row["sentence_text"],
        occurred_at=_date_time(row["created_at"]), duration_ms=row["duration_ms"], status="recorded",
        content_id=row["content_id"] if _source_visible(row, owner) else None,
        source_url=row["contents"].get("source_url") if _source_visible(row, owner) else None,
        sentence_id=row["sentence_id"],
    ) for row in attempts]
    items.extend(ProfileHistoryItem(
        id=row["id"], kind="speaking", title=row["goal"], occurred_at=max(turns),
        turn_count=len(turns), status=row["status"], session_id=row["id"],
        feedback=_feedback(row, turns)[0],
    ) for row, turns in sessions if turns)
    if kind != "all":
        items = [item for item in items if item.kind == kind]
    items.sort(key=lambda item: (item.occurred_at, item.kind, str(item.id)), reverse=True)
    return ProfileHistoryPage(items=items[offset:offset + limit],
                              next_offset=offset + limit if len(items) > offset + limit else None)


def _streak(days: set[date], today: date) -> int:
    current = today if today in days else today - timedelta(days=1)
    streak = 0
    while current in days:
        streak += 1
        current -= timedelta(days=1)
    return streak


def _activity(attempt_dates: list[date], turn_dates: list[date], corpus_dates: list[date],
              corpus_dates_known: bool, today: date, period: ProfileRange) -> ProfileActivity:
    monthly = period == "all"
    earliest = min([today, *attempt_dates, *turn_dates, *corpus_dates])
    start = earliest.replace(day=1) if monthly else today - timedelta(days=27 if period == "4w" else 89)
    buckets: dict[date, ActivityBucket] = {}
    current = start
    while current <= today:
        if len(buckets) >= 1200:
            raise ValueError("Activity date range is too large")
        buckets[current] = ActivityBucket(date=current, corpus_added=0 if corpus_dates_known else None)
        current = (current.replace(day=28) + timedelta(days=4)).replace(day=1) if monthly else current + timedelta(days=1)
    for dates, field in ((attempt_dates, "shadowing_attempts"), (turn_dates, "speaking_turns"),
                         (corpus_dates if corpus_dates_known else [], "corpus_added")):
        for occurred in dates:
            key = occurred.replace(day=1) if monthly else occurred
            if key in buckets:
                setattr(buckets[key], field, getattr(buckets[key], field) + 1)
    return ProfileActivity(bucket="month" if monthly else "day", start_date=start,
                           end_date=today, items=list(buckets.values()))


def get_profile(owner: str, timezone_name: str, period: ProfileRange,
                *, now: datetime | None = None) -> LearningProfile:
    zone = _zone(timezone_name)
    now = now or datetime.now(timezone.utc)
    try:
        records = read_profile_records(owner, now)
        attempts, sessions = _practice_data(records, owner, now)
        today = now.astimezone(zone).date()
        attempt_dates = [_date_time(row["created_at"]).astimezone(zone).date() for row in attempts]
        turn_dates = [turn.astimezone(zone).date() for _, turns in sessions for turn in turns]
        days = set(attempt_dates + turn_dates)
        corpus = [row for row in records.corpus if row.get("user_id") == owner
                  and (not row.get("created_at") or _date_time(row["created_at"]) <= now)]
        dates_known = all(row.get("created_at") for row in corpus)
        corpus_dates = [_date_time(row["created_at"]).astimezone(zone).date()
                        for row in corpus if row.get("created_at")]
        week_start = today - timedelta(days=today.weekday())
        resume = [ResumeSpeaking(session_id=row["id"], goal=row["goal"], status=row["status"],
                  turn_count=len(turns), updated_at=max(turns) if turns else _date_time(row["created_at"]))
                  for row, turns in sessions if row["status"] in ("draft", "active")]
        resume.sort(key=lambda item: (item.updated_at, str(item.session_id)), reverse=True)
        sources = sorted((row for row in attempts if _source_visible(row, owner)),
                         key=lambda row: (_date_time(row["created_at"]), row["id"]), reverse=True)
        latest = sources[0] if sources else None
        feedback, feedback_reason = _latest_feedback(sessions)
        return LearningProfile(timezone=timezone_name, range=period, generated_at=now,
            overview=ProfileOverview(
                shadowing_attempts=len(attempts), speaking_sessions=sum(bool(turns) for _, turns in sessions),
                corpus_total=len(corpus), corpus_structures=sum(row["kind"] == "structure" for row in corpus),
                corpus_week_added=sum(day >= week_start for day in corpus_dates) if dates_known else None,
                shadowing_duration_ms=sum(row["duration_ms"] for row in attempts),
                current_streak_days=_streak(days, today), active_days=len(days)),
            activity=_activity(attempt_dates, turn_dates, corpus_dates, dates_known, today, period),
            resume_speaking=resume[0] if resume else None,
            last_practiced_source=LastPracticedSource(
                content_id=latest["content_id"], sentence_id=latest["sentence_id"],
                source_url=latest["contents"].get("source_url"),
                sentence_text=latest["sentence_text"], title=latest["contents"].get("title"),
                start_ms=latest["start_ms"], practiced_at=_date_time(latest["created_at"])) if latest else None,
            recent_history=_history(attempts, sessions, owner, 0, 5),
            latest_feedback=feedback, latest_feedback_unavailable_reason=feedback_reason)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise unavailable() from None


def get_profile_history(owner: str, offset: int, limit: int, kind: ProfileHistoryKind = "all") -> ProfileHistoryPage:
    now = datetime.now(timezone.utc)
    try:
        records = read_profile_records(owner, now, include_corpus=False)
        attempts, sessions = _practice_data(records, owner, now)
        return _history(attempts, sessions, owner, offset, limit, kind)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise unavailable() from None
