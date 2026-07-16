import json
import os
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import settings as app_settings
from app.main import app

client = TestClient(app)

NONCE = "correct-nonce"
INSTANCE_ID = "evaluation-instance-001"
ADMIN_TOKEN = "secret-token"


def _evaluation_headers(
    *, nonce: str = NONCE, instance_id: str = INSTANCE_ID
) -> dict[str, str]:
    return {
        "X-ProjectFlow-Admin-Token": ADMIN_TOKEN,
        "X-Evaluation-Nonce": nonce,
        "X-Evaluation-Instance-Id": instance_id,
    }


def _configure_evaluation(monkeypatch, temp_root: str) -> None:
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(
        app_settings, "demo_admin_token", SecretStr(ADMIN_TOKEN), raising=False
    )
    monkeypatch.setattr(
        app_settings, "evaluation_nonce", SecretStr(NONCE), raising=False
    )
    monkeypatch.setattr(
        app_settings,
        "evaluation_instance_id",
        SecretStr(INSTANCE_ID),
        raising=False,
    )
    monkeypatch.setattr(
        app_settings, "evaluation_temp_root", temp_root, raising=False
    )


def _write_marker(temp_root: str) -> None:
    marker_path = os.path.join(temp_root, ".evaluator-ownership-marker")
    with open(marker_path, "w", encoding="utf-8") as marker:
        json.dump({"nonce": NONCE, "instanceId": INSTANCE_ID}, marker)


def test_health_requires_matching_nonce_and_instance_identity(monkeypatch):
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(
        app_settings, "evaluation_nonce", SecretStr(NONCE), raising=False
    )
    monkeypatch.setattr(
        app_settings,
        "evaluation_instance_id",
        SecretStr(INSTANCE_ID),
        raising=False,
    )

    assert client.get("/api/health").status_code == 403
    assert (
        client.get(
            "/api/health", headers={"X-Evaluation-Nonce": NONCE}
        ).status_code
        == 403
    )

    response = client.get("/api/health", headers=_evaluation_headers())
    assert response.status_code == 200
    data = response.json()
    assert data["app_env"] == "evaluation"
    assert data["evaluation_instance_id"] == INSTANCE_ID
    assert "evaluation_nonce" not in data
    assert NONCE not in response.text


def test_evaluation_seed_rejects_invalid_nonce(monkeypatch, tmp_path):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation(monkeypatch, temp_root)
    _write_marker(temp_root)
    response = client.post(
        "/api/seed/demo", headers=_evaluation_headers(nonce="wrong-nonce")
    )
    assert response.status_code == 403


def test_reused_nonce_from_another_instance_is_rejected(monkeypatch, tmp_path):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation(monkeypatch, temp_root)
    _write_marker(temp_root)

    response = client.post(
        "/api/seed/demo",
        headers=_evaluation_headers(instance_id="previous-evaluation-instance"),
    )
    assert response.status_code == 403
    assert "Nonce" in response.json()["detail"]


def test_evaluation_seed_rejects_relative_and_outside_database_paths(
    monkeypatch, tmp_path
):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation(monkeypatch, temp_root)
    _write_marker(temp_root)
    monkeypatch.setattr(
        app_settings, "upload_dir", os.path.join(temp_root, "uploads")
    )

    monkeypatch.setattr(
        app_settings, "database_url", "sqlite:///relative/projectflow.sqlite"
    )
    response = client.post("/api/seed/demo", headers=_evaluation_headers())
    assert response.status_code == 403
    assert "绝对路径" in response.json()["detail"]

    outside_db = os.path.join(temp_root, "..", "outside.sqlite")
    monkeypatch.setattr(app_settings, "database_url", f"sqlite:///{outside_db}")
    response = client.post("/api/seed/demo", headers=_evaluation_headers())
    assert response.status_code == 403
    assert "数据库路径超出" in response.json()["detail"]


def test_evaluation_seed_rejects_upload_symlink_escape(monkeypatch, tmp_path):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation(monkeypatch, temp_root)
    _write_marker(temp_root)
    monkeypatch.setattr(
        app_settings,
        "database_url",
        f"sqlite:///{os.path.join(temp_root, 'projectflow.sqlite')}",
    )
    symlink_dir = os.path.join(temp_root, "uploads")
    os.symlink(os.path.join(temp_root, ".."), symlink_dir)
    monkeypatch.setattr(app_settings, "upload_dir", symlink_dir)

    response = client.post("/api/seed/demo", headers=_evaluation_headers())
    assert response.status_code == 403
    assert "上传目录路径超出" in response.json()["detail"]


def test_evaluation_credentials_cannot_authorize_production_target(monkeypatch):
    monkeypatch.setattr(app_settings, "app_env", "production")
    monkeypatch.setattr(
        app_settings,
        "demo_admin_token",
        SecretStr("production-admin-token"),
        raising=False,
    )
    response = client.post("/api/seed/demo", headers=_evaluation_headers())
    assert response.status_code == 403


def test_evaluation_seed_succeeds_only_with_owned_paths_and_identity(
    monkeypatch, tmp_path
):
    temp_root = os.path.realpath(str(tmp_path))
    upload_dir = os.path.join(temp_root, "uploads")
    os.makedirs(upload_dir)
    _configure_evaluation(monkeypatch, temp_root)
    _write_marker(temp_root)
    monkeypatch.setattr(
        app_settings,
        "database_url",
        f"sqlite:///{os.path.join(temp_root, 'projectflow.sqlite')}",
    )
    monkeypatch.setattr(app_settings, "upload_dir", upload_dir)

    with (
        patch("app.api.routes_seed.reset_demo_data") as mock_reset,
        patch("app.api.routes_seed.seed_demo_data") as mock_seed,
    ):
        mock_seed.return_value = {"projects": 1}
        response = client.post("/api/seed/demo", headers=_evaluation_headers())

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    mock_reset.assert_called_once()
    mock_seed.assert_called_once()
