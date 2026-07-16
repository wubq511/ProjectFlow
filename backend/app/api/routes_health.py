from fastapi import APIRouter

from app.schemas.health import HealthResponse

from app.core.config import settings
import os

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def get_health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        service="projectflow-backend",
        app_env=settings.app_env,
        evaluation_nonce=os.environ.get("EVALUATION_NONCE"),
    )
