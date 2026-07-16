import os
from unittest.mock import patch
from pydantic import SecretStr
from fastapi.testclient import TestClient

from app.core.config import settings as app_settings
from app.main import app

client = TestClient(app)


def test_health_endpoint_evaluation_mode(monkeypatch):
    """Test that health check exposes evaluation nonce and app_env when app_env=evaluation."""
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    
    with patch.dict(os.environ, {"EVALUATION_NONCE": "test-nonce-123"}):
        response = client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["app_env"] == "evaluation"
        assert data["evaluation_nonce"] == "test-nonce-123"


def test_require_demo_admin_access_evaluation_mode_invalid_nonce(monkeypatch):
    """Should raise 403 when in evaluation mode and nonce header is missing or mismatched."""
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(app_settings, "demo_admin_token", SecretStr("secret-token"), raising=False)
    
    with patch.dict(os.environ, {"EVALUATION_NONCE": "correct-nonce"}):
        # Mismatched nonce
        headers = {
            "X-ProjectFlow-Admin-Token": "secret-token",
            "X-Evaluation-Nonce": "wrong-nonce"
        }
        response = client.post("/api/seed/demo", headers=headers)
        assert response.status_code == 403
        assert "nonce" in response.json()["detail"].lower()


def test_require_demo_admin_access_evaluation_mode_outside_temp_root(monkeypatch):
    """Should raise 403 when sqlite database path or upload path is outside temp root."""
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(app_settings, "demo_admin_token", SecretStr("secret-token"), raising=False)
    # Set DB url outside temporary root
    monkeypatch.setattr(app_settings, "database_url", "sqlite:///./data/projectflow.sqlite")
    monkeypatch.setattr(app_settings, "upload_dir", "/unauthorized/uploads")
    
    with patch.dict(os.environ, {
        "EVALUATION_NONCE": "correct-nonce",
        "EVALUATION_TEMP_ROOT": "/tmp/valid-eval-root"
    }):
        headers = {
            "X-ProjectFlow-Admin-Token": "secret-token",
            "X-Evaluation-Nonce": "correct-nonce"
        }
        response = client.post("/api/seed/demo", headers=headers)
        assert response.status_code == 403
        assert "temporary root" in response.json()["detail"].lower()


def test_require_demo_admin_access_evaluation_mode_success(monkeypatch, tmp_path):
    """Should pass security check and return 200 when all conditions (nonce, token, path containment) match."""
    # Convert tmp_path to real path to avoid symlink issues on mac (/var/folders vs /private/var/folders)
    temp_root = os.path.realpath(str(tmp_path))
    db_file_path = os.path.join(temp_root, "projectflow_eval.sqlite")
    upload_dir_path = os.path.join(temp_root, "uploads")
    
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(app_settings, "demo_admin_token", SecretStr("secret-token"), raising=False)
    monkeypatch.setattr(app_settings, "database_url", f"sqlite:///{db_file_path}")
    monkeypatch.setattr(app_settings, "upload_dir", upload_dir_path)
    
    # Mock database seeding and resetting to avoid actual db operations on file
    with patch("app.api.routes_seed.reset_demo_data") as mock_reset, \
         patch("app.api.routes_seed.seed_demo_data") as mock_seed, \
         patch.dict(os.environ, {
             "EVALUATION_NONCE": "correct-nonce",
             "EVALUATION_TEMP_ROOT": temp_root
         }):
        mock_seed.return_value = {"projects": 1}
        
        headers = {
            "X-ProjectFlow-Admin-Token": "secret-token",
            "X-Evaluation-Nonce": "correct-nonce"
        }
        response = client.post("/api/seed/demo", headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        mock_reset.assert_called_once()
        mock_seed.assert_called_once()
