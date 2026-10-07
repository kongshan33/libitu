from typing import Annotated

from fastapi import APIRouter, Query, Response

from app.auth import CurrentUserDep
from app.schemas.profile import LearningProfile, ProfileHistoryPage, ProfileRange, ProfileHistoryKind
from app.services.profile_service import get_profile, get_profile_history

router = APIRouter(prefix="/api/profile", tags=["profile"])


@router.get("")
def profile(user: CurrentUserDep, response: Response,
            timezone: Annotated[str, Query(min_length=1, max_length=100)] = "UTC",
            range: Annotated[ProfileRange, Query()] = "4w") -> LearningProfile:
    response.headers["Cache-Control"] = "private, no-store"
    return get_profile(user.id, timezone, range)


@router.get("/history")
def history(user: CurrentUserDep, response: Response,
            offset: Annotated[int, Query(ge=0, le=100000)] = 0,
            limit: Annotated[int, Query(ge=1, le=50)] = 10,
            kind: Annotated[ProfileHistoryKind, Query()] = "all") -> ProfileHistoryPage:
    response.headers["Cache-Control"] = "private, no-store"
    return get_profile_history(user.id, offset, limit, kind)
