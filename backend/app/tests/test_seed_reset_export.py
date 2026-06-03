"""Tests for demo seed, reset, and review summary export endpoints."""

from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import settings as app_settings


class TestSeedEndpoint:
    """Tests for POST /api/seed/demo."""

    def test_seed_demo_returns_ok(self, client: TestClient):
        response = client.post("/api/seed/demo")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        summary = data["summary"]
        assert summary["users"] == 6
        assert summary["workspace"] == 1
        assert summary["project"] == 1
        assert summary["stages"] == 4
        assert summary["tasks"] == 10
        assert summary["risks"] == 3
        assert summary["action_cards"] == 5
        assert summary["agent_events"] == 5

    def test_seed_demo_is_idempotent(self, client: TestClient):
        # Seed twice — each call resets then seeds, so both succeed
        r1 = client.post("/api/seed/demo")
        r2 = client.post("/api/seed/demo")
        assert r1.status_code == 200
        assert r2.status_code == 200
        # Both should report the same counts
        assert r1.json()["summary"]["users"] == r2.json()["summary"]["users"]

    def test_seed_creates_expected_users(self, client: TestClient):
        client.post("/api/seed/demo")
        # Verify users exist via list endpoint
        response = client.get("/api/users")
        assert response.status_code == 200
        users = response.json()
        assert len(users) >= 6
        names = {u["display_name"] for u in users}
        assert "小林" in names
        assert "小王" in names
        assert "小张" in names

    def test_seed_creates_workspace(self, client: TestClient):
        client.post("/api/seed/demo")
        # Verify workspace exists
        response = client.get("/api/workspaces/demo-workspace-001")
        assert response.status_code == 200
        ws = response.json()
        assert ws["name"] == "ProjectFlow 团队"

    def test_seed_project_direction_card_uses_current_shape(self, client: TestClient):
        client.post("/api/seed/demo")

        response = client.get("/api/projects/demo-project-001")

        assert response.status_code == 200
        direction_card = response.json()["direction_card"]
        assert direction_card["users"] == "大学生项目小队（3-8人）"
        assert "AI Agent 主动推进项目" in direction_card["value"]
        assert "本地演示优先" in direction_card["boundaries"]
        assert "Agent 输出不稳定" in direction_card["risks"]
        assert "target_users" not in direction_card
        assert "core_value" not in direction_card

    def test_seed_action_cards_include_usability_fields(self, client: TestClient):
        client.post("/api/seed/demo")

        response = client.get("/api/projects/demo-project-001/action-cards")

        assert response.status_code == 200
        cards = response.json()
        assert cards
        assert all(card["goal"] for card in cards)
        assert all(card["start_suggestion"] for card in cards)
        assert all(card["completion_standard"] for card in cards)


class TestResetEndpoint:
    """Tests for POST /api/seed/reset."""

    def test_reset_returns_ok(self, client: TestClient):
        # Seed first, then reset
        client.post("/api/seed/demo")
        response = client.post("/api/seed/reset")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "deleted" in data
        # Should have deleted users
        assert data["deleted"]["users"] >= 0

    def test_reset_clears_users(self, client: TestClient):
        client.post("/api/seed/demo")
        client.post("/api/seed/reset")
        # After reset, no users should remain
        response = client.get("/api/users")
        assert response.status_code == 200
        assert len(response.json()) == 0

    def test_reset_then_seed_works(self, client: TestClient):
        # Full cycle: seed -> reset -> seed
        client.post("/api/seed/demo")
        client.post("/api/seed/reset")
        response = client.post("/api/seed/demo")
        assert response.status_code == 200
        assert response.json()["summary"]["users"] == 6

    def test_reset_on_empty_db_is_safe(self, client: TestClient):
        # Resetting an already-empty DB should not error
        client.post("/api/seed/reset")
        response = client.post("/api/seed/reset")
        assert response.status_code == 200

    def test_reset_is_blocked_outside_development_without_admin_token(self, client: TestClient, monkeypatch):
        monkeypatch.setattr(app_settings, "app_env", "production")
        monkeypatch.setattr(app_settings, "demo_admin_token", None, raising=False)

        response = client.post("/api/seed/reset")

        assert response.status_code == 403

    def test_reset_accepts_admin_token_outside_development(self, client: TestClient, monkeypatch):
        monkeypatch.setattr(app_settings, "app_env", "production")
        monkeypatch.setattr(app_settings, "demo_admin_token", SecretStr("admin-token"), raising=False)

        response = client.post("/api/seed/reset", headers={"X-ProjectFlow-Admin-Token": "admin-token"})

        assert response.status_code == 200


class TestExportEndpoint:
    """Tests for POST /api/projects/{project_id}/export/review-summary."""

    def test_export_returns_markdown(self, client: TestClient):
        client.post("/api/seed/demo")
        response = client.post("/api/projects/demo-project-001/export/review-summary")
        assert response.status_code == 200
        data = response.json()
        assert "markdown" in data
        md = data["markdown"]
        assert "ProjectFlow" in md
        assert "评审摘要" in md

    def test_export_includes_product_positioning(self, client: TestClient):
        client.post("/api/seed/demo")
        response = client.post("/api/projects/demo-project-001/export/review-summary")
        md = response.json()["markdown"]
        assert "产品定位" in md
        assert "核心价值" in md
        assert "大学生项目小队（3-8人）" in md
        assert "AI Agent 主动推进项目" in md

    def test_export_includes_risks(self, client: TestClient):
        client.post("/api/seed/demo")
        response = client.post("/api/projects/demo-project-001/export/review-summary")
        md = response.json()["markdown"]
        assert "风险" in md
        assert "外键约束" in md

    def test_export_includes_team(self, client: TestClient):
        client.post("/api/seed/demo")
        response = client.post("/api/projects/demo-project-001/export/review-summary")
        md = response.json()["markdown"]
        assert "团队" in md

    def test_export_includes_actions(self, client: TestClient):
        client.post("/api/seed/demo")
        response = client.post("/api/projects/demo-project-001/export/review-summary")
        md = response.json()["markdown"]
        assert "下一步行动" in md
        assert "目标：" in md
        assert "如何开始：" in md
        assert "完成标准：" in md

    def test_export_includes_timeline(self, client: TestClient):
        client.post("/api/seed/demo")
        response = client.post("/api/projects/demo-project-001/export/review-summary")
        md = response.json()["markdown"]
        assert "时间线" in md or "Agent" in md

    def test_export_404_for_missing_project(self, client: TestClient):
        response = client.post("/api/projects/nonexistent-project/export/review-summary")
        assert response.status_code == 404
