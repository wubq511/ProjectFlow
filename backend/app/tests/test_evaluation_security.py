import os
from unittest.mock import patch
from pydantic import SecretStr
from fastapi.testclient import TestClient

from app.core.config import settings as app_settings
from app.main import app

client = TestClient(app)


def test_health_endpoint_evaluation_mode(monkeypatch):
    """测试评估模式下 health 接口：无 nonce 头返回 403，有正确 nonce 头正常返回但绝不泄露 nonce 内容。"""
    monkeypatch.setattr(app_settings, "app_env", "evaluation")

    with patch.dict(os.environ, {"EVALUATION_NONCE": "test-nonce-123"}):
        # 1. 无头请求 -> 403
        response = client.get("/api/health")
        assert response.status_code == 403
        assert "nonce" in response.json()["detail"].lower()

        # 2. 携带正确 nonce -> 200
        headers = {"X-Evaluation-Nonce": "test-nonce-123"}
        response = client.get("/api/health", headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["app_env"] == "evaluation"
        assert "evaluation_nonce" not in data


def test_require_demo_admin_access_evaluation_mode_invalid_nonce(monkeypatch):
    """测试评估模式下：nonce 缺失或不匹配时，拒绝破坏性操作并返回 403。"""
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(app_settings, "demo_admin_token", SecretStr("secret-token"), raising=False)

    with patch.dict(os.environ, {"EVALUATION_NONCE": "correct-nonce"}):
        # 不匹配的 nonce
        headers = {
            "X-ProjectFlow-Admin-Token": "secret-token",
            "X-Evaluation-Nonce": "wrong-nonce"
        }
        response = client.post("/api/seed/demo", headers=headers)
        assert response.status_code == 403
        assert "nonce" in response.json()["detail"].lower()


def test_require_demo_admin_access_evaluation_mode_outside_temp_root(monkeypatch, tmp_path):
    """测试评估模式下：数据库路径或上传路径位于 temp 根目录之外时，拒绝破坏性操作并返回 403。"""
    temp_root = os.path.realpath(str(tmp_path))
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(app_settings, "demo_admin_token", SecretStr("secret-token"), raising=False)
    monkeypatch.setattr(app_settings, "database_url", "sqlite:///./data/projectflow.sqlite")
    monkeypatch.setattr(app_settings, "upload_dir", "/unauthorized/uploads")

    # 写入所有权标记文件
    marker_path = os.path.join(temp_root, ".evaluator-ownership-marker")
    with open(marker_path, "w", encoding="utf-8") as f:
        f.write("correct-nonce")

    with patch.dict(os.environ, {
        "EVALUATION_NONCE": "correct-nonce",
        "EVALUATION_TEMP_ROOT": temp_root
    }):
        headers = {
            "X-ProjectFlow-Admin-Token": "secret-token",
            "X-Evaluation-Nonce": "correct-nonce"
        }
        response = client.post("/api/seed/demo", headers=headers)
        assert response.status_code == 403
        assert "目录限制" in response.json()["detail"]


def test_require_demo_admin_access_adversarial_paths(monkeypatch, tmp_path):
    """测试对抗性路径转义：相对路径试图穿透、软链接外部试图逃逸，以及所有权标记校验。"""
    temp_root = os.path.realpath(str(tmp_path))
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(app_settings, "demo_admin_token", SecretStr("secret-token"), raising=False)

    # 1. 相对路径穿透测试 (sqlite:///temp_root/../../outside.db)
    escape_db_path = os.path.normpath(os.path.join(temp_root, "..", "outside.sqlite"))
    monkeypatch.setattr(app_settings, "database_url", f"sqlite:///{escape_db_path}")
    monkeypatch.setattr(app_settings, "upload_dir", os.path.join(temp_root, "uploads"))

    # 写入所有权标记文件
    marker_path = os.path.join(temp_root, ".evaluator-ownership-marker")
    with open(marker_path, "w", encoding="utf-8") as f:
        f.write("correct-nonce")

    with patch.dict(os.environ, {
        "EVALUATION_NONCE": "correct-nonce",
        "EVALUATION_TEMP_ROOT": temp_root
    }):
        headers = {
            "X-ProjectFlow-Admin-Token": "secret-token",
            "X-Evaluation-Nonce": "correct-nonce"
        }
        response = client.post("/api/seed/demo", headers=headers)
        assert response.status_code == 403
        assert "数据库路径超出" in response.json()["detail"]

    # 2. 软链接试图逃逸 (uploads 软链接指向 /tmp 外部目录)
    # 恢复合法 DB 路径
    db_file_path = os.path.join(temp_root, "projectflow_eval.sqlite")
    monkeypatch.setattr(app_settings, "database_url", f"sqlite:///{db_file_path}")

    # 创建软链接 uploads -> 外部目录
    symlink_dir = os.path.join(temp_root, "uploads_symlink")
    outside_dir = os.path.join(temp_root, "..")
    os.symlink(outside_dir, symlink_dir)

    monkeypatch.setattr(app_settings, "upload_dir", symlink_dir)

    with patch.dict(os.environ, {
        "EVALUATION_NONCE": "correct-nonce",
        "EVALUATION_TEMP_ROOT": temp_root
    }):
        headers = {
            "X-ProjectFlow-Admin-Token": "secret-token",
            "X-Evaluation-Nonce": "correct-nonce"
        }
        response = client.post("/api/seed/demo", headers=headers)
        assert response.status_code == 403
        assert "上传目录路径超出" in response.json()["detail"]


def test_require_demo_admin_access_evaluation_mode_success(monkeypatch, tmp_path):
    """测试成功路径：所有权标记文件存在、nonce/token 匹配、路径安全限制全通过。"""
    temp_root = os.path.realpath(str(tmp_path))
    db_file_path = os.path.join(temp_root, "projectflow_eval.sqlite")
    upload_dir_path = os.path.join(temp_root, "uploads")
    os.makedirs(upload_dir_path, exist_ok=True)

    # 写入所有权标记文件
    marker_path = os.path.join(temp_root, ".evaluator-ownership-marker")
    with open(marker_path, "w", encoding="utf-8") as f:
        f.write("correct-nonce")

    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(app_settings, "demo_admin_token", SecretStr("secret-token"), raising=False)
    monkeypatch.setattr(app_settings, "database_url", f"sqlite:///{db_file_path}")
    monkeypatch.setattr(app_settings, "upload_dir", upload_dir_path)

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
