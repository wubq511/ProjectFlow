import hmac
import json
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
    x_evaluation_instance_id: Annotated[
        str | None,
        Header(alias="X-Evaluation-Instance-Id"),
    ] = None,
) -> None:
    """Protect destructive demo endpoints outside the local development loop."""
    if settings.app_env == "development":
        return

    if settings.app_env == "evaluation":
        import os

        def is_contained_in(path: str, parent: str) -> bool:
            abs_path = os.path.realpath(path)
            abs_parent = os.path.realpath(parent)
            return abs_path == abs_parent or abs_path.startswith(abs_parent + os.sep)

        # 1. Nonce check
        expected_nonce = settings.evaluation_nonce.get_secret_value() if settings.evaluation_nonce else None
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
            raise HTTPException(status_code=403, detail="评估 Nonce 不匹配")

        # 2. Temp root containment check
        temp_root = settings.evaluation_temp_root
        if not temp_root:
            raise HTTPException(status_code=403, detail="未设置 EVALUATION_TEMP_ROOT 环境变量")
        temp_root_abs = os.path.realpath(temp_root)

        # 3. Ownership marker check
        marker_path = os.path.join(temp_root_abs, ".evaluator-ownership-marker")
        if not os.path.isfile(marker_path):
            raise HTTPException(status_code=403, detail="缺少评估所有权标记文件")
        try:
            with open(marker_path, encoding="utf-8") as f:
                marker = json.load(f)
        except (OSError, json.JSONDecodeError):
            raise HTTPException(status_code=403, detail="读取评估所有权标记文件失败")
        marker_nonce = marker.get("nonce") if isinstance(marker, dict) else None
        marker_instance_id = marker.get("instanceId") if isinstance(marker, dict) else None
        if (
            not isinstance(marker_nonce, str)
            or not isinstance(marker_instance_id, str)
            or not hmac.compare_digest(marker_nonce, expected_nonce)
            or not hmac.compare_digest(marker_instance_id, expected_instance_id)
        ):
            raise HTTPException(status_code=403, detail="评估所有权标记不匹配")

        # Verify database path is sqlite and resolved path is inside temp_root_abs
        db_url = settings.database_url
        if not db_url.startswith("sqlite:///"):
            raise HTTPException(status_code=403, detail="评估环境必须使用 SQLite 数据库")

        db_path = db_url.removeprefix("sqlite:///")
        if not os.path.isabs(db_path):
            raise HTTPException(status_code=403, detail="评估数据库必须使用绝对路径")
        if not is_contained_in(db_path, temp_root_abs):
            raise HTTPException(status_code=403, detail="数据库路径超出评估临时根目录限制")

        # Verify upload directory path is inside temp_root_abs
        if not is_contained_in(settings.resolved_upload_dir, temp_root_abs):
            raise HTTPException(status_code=403, detail="上传目录路径超出评估临时根目录限制")

    expected_token = settings.demo_admin_token.get_secret_value() if settings.demo_admin_token else None
    if not expected_token:
        raise HTTPException(
            status_code=403,
            detail="演示管理员接口在开发环境之外已禁用",
        )
    if not x_projectflow_admin_token or not hmac.compare_digest(
        x_projectflow_admin_token, expected_token
    ):
        raise HTTPException(status_code=403, detail="需要演示管理员 Token")


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
