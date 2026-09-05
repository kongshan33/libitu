from typing import Annotated

from clerk_backend_api import AuthenticateRequestOptions, authenticate_request
from fastapi import Depends, HTTPException, Request, status
from pydantic import BaseModel

from app.config import Settings, get_settings


class AuthenticatedUser(BaseModel):
    id: str


SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_optional_user(request: Request, settings: SettingsDep) -> AuthenticatedUser | None:
    authorization = request.headers.get("authorization")
    if not authorization:
        return None
    if not settings.clerk_is_configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured",
        )

    try:
        auth_state = authenticate_request(
            request,
            AuthenticateRequestOptions(
                secret_key=settings.clerk_secret_key,
                jwt_key=settings.clerk_jwt_key,
                authorized_parties=settings.authorized_parties,
                accepts_token=["session_token"],
            ),
        )
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
        ) from error

    if not auth_state.is_signed_in:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    user_id = auth_state.payload.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token is missing a user ID",
        )
    return AuthenticatedUser(id=user_id)


OptionalUserDep = Annotated[AuthenticatedUser | None, Depends(get_optional_user)]


def require_user(user: OptionalUserDep) -> AuthenticatedUser:
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    return user


CurrentUserDep = Annotated[AuthenticatedUser, Depends(require_user)]
