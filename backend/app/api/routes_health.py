import os
from fastapi import APIRouter, Header, HTTPException
from app.schemas.health import HealthResponse
from app.core.config import settings

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def get_health(
    x_evaluation_nonce: str | None = Header(None, alias="X-Evaluation-Nonce")
) -> HealthResponse:
    if settings.app_env == "evaluation":
        expected_nonce = os.environ.get("EVALUATION_NONCE")
        if not expected_nonce or x_evaluation_nonce != expected_nonce:
            raise HTTPException(status_code=403, detail="无效的评估 Nonce")
    return HealthResponse(
        status="ok",
        service="projectflow-backend",
        app_env=settings.app_env,
    )
