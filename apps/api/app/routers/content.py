from fastapi import APIRouter

from app.schemas.content import ContentResolveRequest, ContentResolveResponse
from app.services.content_resolver import resolve_content

router = APIRouter()


@router.post("/resolve")
def resolve(payload: ContentResolveRequest) -> ContentResolveResponse:
    return resolve_content(payload)
