import hmac
from typing import Annotated

from fastapi import Header, HTTPException

from app.core.config import settings


def require_demo_admin_access(
    x_projectflow_admin_token: Annotated[
        str | None,
        Header(alias="X-ProjectFlow-Admin-Token"),
    ] = None,
    x_evaluation_nonce: Annotated[
        str | None,
        Header(alias="X-Evaluation-Nonce"),
    ] = None,
) -> None:
    """Protect destructive demo endpoints outside the local development loop."""
    if settings.app_env == "development":
        return

    if settings.app_env == "evaluation":
        import os
        # 1. Nonce check
        expected_nonce = os.environ.get("EVALUATION_NONCE")
        if not expected_nonce or x_evaluation_nonce != expected_nonce:
            raise HTTPException(status_code=403, detail="Evaluation nonce mismatch")

        # 2. Temp root containment check
        temp_root = os.environ.get("EVALUATION_TEMP_ROOT")
        if not temp_root:
            raise HTTPException(status_code=403, detail="EVALUATION_TEMP_ROOT not set")
        temp_root_abs = os.path.realpath(temp_root)

        # Verify database path is sqlite and resolved path is inside temp_root_abs
        db_url = settings.database_url
        if not db_url.startswith("sqlite"):
            raise HTTPException(status_code=403, detail="Evaluation requires SQLite database")
        
        db_path = db_url.removeprefix("sqlite:///")
        db_abs_path = os.path.realpath(db_path)
        if not db_abs_path.startswith(temp_root_abs + os.sep):
            raise HTTPException(status_code=403, detail="Database path outside temporary root")

        # Verify upload directory path is inside temp_root_abs
        upload_dir_abs = os.path.realpath(settings.resolved_upload_dir)
        if not upload_dir_abs.startswith(temp_root_abs + os.sep):
            raise HTTPException(status_code=403, detail="Upload directory path outside temporary root")

    expected_token = settings.demo_admin_token.get_secret_value() if settings.demo_admin_token else None
    if not expected_token:
        raise HTTPException(
            status_code=403,
            detail="Demo admin endpoints are disabled outside development",
        )
    if x_projectflow_admin_token != expected_token:
        raise HTTPException(status_code=403, detail="Demo admin token required")


def require_internal_service_access(
    authorization: Annotated[
        str | None,
        Header(alias="Authorization"),
    ] = None,
) -> None:
    """Protect sidecar-facing internal endpoints with a bearer service token."""
    expected_token = settings.internal_service_token.get_secret_value() if settings.internal_service_token else None
    if not expected_token:
        raise HTTPException(status_code=403, detail="Internal service token is not configured")

    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        raise HTTPException(status_code=403, detail="Internal service token required")

    token = authorization.removeprefix(prefix)
    if not hmac.compare_digest(token, expected_token):
        raise HTTPException(status_code=403, detail="Invalid internal service token")
