"""Tests for demo seed, reset, and review summary export endpoints."""

import json

from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.core.config import settings as app_settings
from app.models import (
    AgentConversation,
    AgentEvent,
    AgentMessage,
    AgentProposal,
    AgentRun,
    AgentRunEvent,
    AgentRunV2,
    AgentToolResource,
    ProjectMemory,
    ProjectMemorySync,
)
from app.models.enums import AgentRunStatus, RuntimeEventType
from app.seed.demo_projectflow import PROJECT_ID, WORKSPACE_ID, seed_demo_data
from app.seed.reset import ALL_TABLES, reset_demo_data


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
        assert summary["tasks"] == 11
        assert summary["risks"] == 3
        assert summary["action_cards"] == 5
        assert summary["agent_events"] == 8
        assert summary["agent_proposals"] == 5
        assert summary["project_memories"] == 7
        assert summary["checkin_responses"] == 6
        assert summary["agent_conversations"] == 3

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
        assert "本地运行优先" in direction_card["boundaries"]
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

    def test_reset_tracks_every_sqlmodel_table(self):
        modeled_tables = set(SQLModel.metadata.tables)
        reset_tables = {model.__tablename__ for model in ALL_TABLES}

        assert modeled_tables == reset_tables

    def test_reset_clears_agent_conversation_and_proposal_tables(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            json_serializer=json.dumps,
            json_deserializer=json.loads,
        )

        @sqlalchemy_event.listens_for(engine, "connect")
        def _enable_foreign_keys(dbapi_connection, _connection_record):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

        SQLModel.metadata.create_all(engine)
        with Session(engine) as session:
            seed_demo_data(session)
            event = session.exec(select(AgentEvent)).first()
            assert event is not None

            conversation = AgentConversation(
                id="test-conversation-001",
                workspace_id=WORKSPACE_ID,
                project_id=PROJECT_ID,
            )
            session.add(conversation)
            session.flush()

            proposal = AgentProposal(
                id="test-proposal-001",
                project_id=PROJECT_ID,
                workspace_id=WORKSPACE_ID,
                proposal_type="clarify",
                agent_event_id=event.id,
                payload="{}",
            )
            session.add(proposal)
            session.flush()

            session.add(
                AgentMessage(
                    id="test-message-001",
                    conversation_id=conversation.id,
                    role="user",
                    content="重新加载演示数据前的旧消息",
                )
            )
            session.add(
                AgentRun(
                    id="test-run-001",
                    conversation_id=conversation.id,
                    project_id=PROJECT_ID,
                    user_instruction="生成方向卡",
                    selected_module="clarify",
                    status="proposal_created",
                    agent_event_id=event.id,
                    proposal_id=proposal.id,
                )
            )
            runtime_run = AgentRunV2(
                id="test-run-v2-001",
                conversation_id=conversation.id,
                project_id=PROJECT_ID,
                workspace_id=WORKSPACE_ID,
                viewer_user_id="demo-user-001",
                status=AgentRunStatus.completed,
            )
            session.add(runtime_run)
            session.flush()

            runtime_event = AgentRunEvent(
                id="test-run-event-001",
                run_id=runtime_run.id,
                conversation_id=conversation.id,
                workspace_id=WORKSPACE_ID,
                project_id=PROJECT_ID,
                type=RuntimeEventType.run_completed,
                event_seq=1,
                client_event_id="test-client-event-001",
            )
            runtime_event.set_payload({"status": "completed"})
            runtime_event.set_trace({})
            session.add(runtime_event)
            session.add(
                AgentToolResource(
                    id="test-tool-resource-001",
                    run_id=runtime_run.id,
                    workspace_id=WORKSPACE_ID,
                    project_id=PROJECT_ID,
                    tool_call_id="test-tool-call-001",
                    tool_name="get_workspace_state",
                    content="{}",
                    total_bytes=2,
                    content_hash="test-content-hash",
                )
            )

            memory = ProjectMemory(
                id="test-memory-001",
                workspace_id=WORKSPACE_ID,
                project_id=PROJECT_ID,
                memory_type="plan",
                scope="project",
                content="测试计划记忆",
                rationale="验证演示重置覆盖全部持久化表",
                source_type="direction_card_confirmed",
                source_id="test-source-001",
            )
            session.add(memory)
            session.flush()
            session.add(ProjectMemorySync(memory_id=memory.id))
            session.commit()

            result = reset_demo_data(session)

            assert result["deleted"]["agent_messages"] == 19  # 18 seed + 1 test
            assert result["deleted"]["agent_runs"] == 1  # 0 seed + 1 test
            assert result["deleted"]["agent_conversations"] == 4  # 3 seed + 1 test
            assert result["deleted"]["agent_proposals"] == 6  # 5 seed + 1 test
            assert result["deleted"]["agent_run_events"] == 1
            assert result["deleted"]["agent_tool_resources"] == 1
            assert result["deleted"]["agent_runs_v2"] == 1
            assert result["deleted"]["project_memory_sync"] == 8  # 7 seed + 1 test
            assert result["deleted"]["project_memories"] == 8  # 7 seed + 1 test
            assert session.exec(select(AgentMessage)).all() == []
            assert session.exec(select(AgentRun)).all() == []
            assert session.exec(select(AgentConversation)).all() == []
            assert session.exec(select(AgentProposal)).all() == []
            assert session.exec(select(AgentRunEvent)).all() == []
            assert session.exec(select(AgentToolResource)).all() == []
            assert session.exec(select(AgentRunV2)).all() == []
            assert session.exec(select(ProjectMemorySync)).all() == []
            assert session.exec(select(ProjectMemory)).all() == []

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
