import hmac

from fastapi import APIRouter, Header, HTTPException
from app.schemas.health import HealthResponse
from app.core.config import settings

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, response_model_exclude_none=True)
def get_health(
    x_evaluation_nonce: str | None = Header(None, alias="X-Evaluation-Nonce"),
    x_evaluation_instance_id: str | None = Header(
        None, alias="X-Evaluation-Instance-Id"
    ),
) -> HealthResponse:
    if settings.app_env == "evaluation":
        expected_nonce = (
            settings.evaluation_nonce.get_secret_value()
            if settings.evaluation_nonce
            else None
        )
        expected_instance_id = (
            settings.evaluation_instance_id.get_secret_value()
            if settings.evaluation_instance_id
            else None
        )
        if (
            not expected_nonce
            or not expected_instance_id
            or not x_evaluation_nonce
            or not x_evaluation_instance_id
            or not hmac.compare_digest(x_evaluation_nonce, expected_nonce)
            or not hmac.compare_digest(x_evaluation_instance_id, expected_instance_id)
        ):
            raise HTTPException(status_code=403, detail="无效的评估 Nonce")
    return HealthResponse(
        status="ok",
        service="projectflow-backend",
        app_env=settings.app_env,
        evaluation_instance_id=(
            settings.evaluation_instance_id.get_secret_value()
            if settings.app_env == "evaluation" and settings.evaluation_instance_id
            else None
        ),
    )
