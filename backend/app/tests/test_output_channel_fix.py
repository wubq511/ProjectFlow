"""
Regression tests for the conversation output-channel fix.

Bug: accumulated_content (containing toolcall deltas) was persisted as
AgentMessage.content. execution_steps were not persisted.

Fix: AgentMessage.content = final answer only. execution_steps persisted
in structured_payload. Fold renders on reload.
"""
import pytest


@pytest.fixture
def seeded_project(client):
    """Create a workspace + project + conversation for testing."""
    owner = client.post("/api/users", json={"display_name": "测试用户"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "测试工作区"},
        params={"owner_user_id": owner["id"]},
    ).json()
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "测试项目",
            "idea": "测试方向",
            "deadline": "2026-08-01",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()

    # Get conversation
    conv_resp = client.get(f"/api/projects/{project['id']}/agent-conversation")
    assert conv_resp.status_code == 200
    conv_id = conv_resp.json()["id"]

    return {
        "workspace_id": workspace["id"],
        "project_id": project["id"],
        "conversation_id": conv_id,
        "owner_id": owner["id"],
    }


class TestSaveAssistantMessage:
    """Test _save_assistant_message persists content and execution_steps correctly."""

    def test_save_with_execution_steps(self):
        """execution_steps are persisted in structured_payload."""
        from sqlalchemy.pool import StaticPool
        from sqlmodel import Session, SQLModel, create_engine
        from app.models.agent_conversation import AgentConversation
        from app.services.agent_conversation_service import _save_assistant_message

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)

        with Session(engine) as session:
            conv = AgentConversation(workspace_id="ws_test", project_id="proj_test", status="active")
            session.add(conv)
            session.commit()
            session.refresh(conv)

            steps = [
                {"tool_name": "get_project_state", "status": "completed", "label": "调用get_project_state"},
                {"tool_name": "generate_plan_proposal", "status": "completed", "label": "调用generate_plan_proposal"},
            ]
            msg = _save_assistant_message(session, conv, "这是最终回答内容。", execution_steps=steps)

            assert msg.content == "这是最终回答内容。"
            payload = msg.get_structured_payload()
            assert "execution_steps" in payload
            assert len(payload["execution_steps"]) == 2
            assert payload["execution_steps"][0]["tool_name"] == "get_project_state"
            assert payload["execution_steps"][0]["status"] == "completed"

    def test_save_without_execution_steps(self):
        """No execution_steps key when not provided."""
        from sqlalchemy.pool import StaticPool
        from sqlmodel import Session, SQLModel, create_engine
        from app.models.agent_conversation import AgentConversation
        from app.services.agent_conversation_service import _save_assistant_message

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)

        with Session(engine) as session:
            conv = AgentConversation(workspace_id="ws_test", project_id="proj_test", status="active")
            session.add(conv)
            session.commit()
            session.refresh(conv)

            msg = _save_assistant_message(session, conv, "简单回答。")
            payload = msg.get_structured_payload()
            assert "execution_steps" not in payload

    def test_save_with_thinking_content(self):
        """thinking_content is persisted in structured_payload."""
        from sqlalchemy.pool import StaticPool
        from sqlmodel import Session, SQLModel, create_engine
        from app.models.agent_conversation import AgentConversation
        from app.services.agent_conversation_service import _save_assistant_message

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)

        with Session(engine) as session:
            conv = AgentConversation(workspace_id="ws_test", project_id="proj_test", status="active")
            session.add(conv)
            session.commit()
            session.refresh(conv)

            msg = _save_assistant_message(
                session, conv, "最终回答。",
                thinking_content="让我分析一下项目状态...",
            )
            payload = msg.get_structured_payload()
            assert payload["thinking_content"] == "让我分析一下项目状态..."

    def test_save_without_thinking_content(self):
        """No thinking_content key when not provided."""
        from sqlalchemy.pool import StaticPool
        from sqlmodel import Session, SQLModel, create_engine
        from app.models.agent_conversation import AgentConversation
        from app.services.agent_conversation_service import _save_assistant_message

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)

        with Session(engine) as session:
            conv = AgentConversation(workspace_id="ws_test", project_id="proj_test", status="active")
            session.add(conv)
            session.commit()
            session.refresh(conv)

            msg = _save_assistant_message(session, conv, "简单回答。")
            payload = msg.get_structured_payload()
            assert "thinking_content" not in payload

    def test_content_is_only_final_answer(self):
        """AgentMessage.content must be only the final answer, not accumulated tokens."""
        from sqlalchemy.pool import StaticPool
        from sqlmodel import Session, SQLModel, create_engine
        from app.models.agent_conversation import AgentConversation
        from app.services.agent_conversation_service import _save_assistant_message

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)

        with Session(engine) as session:
            conv = AgentConversation(workspace_id="ws_test", project_id="proj_test", status="active")
            session.add(conv)
            session.commit()
            session.refresh(conv)

            final_answer = "根据分析，项目当前处于阶段计划阶段。"
            msg = _save_assistant_message(session, conv, final_answer)

            assert msg.content == final_answer
            assert "toolCall" not in msg.content
            assert "get_project_state" not in msg.content


class TestExecutionStepsInApi:
    """Test that execution_steps are returned in the conversation API."""

    def test_assistant_message_has_execution_steps_in_payload(self, client, seeded_project):
        """After saving with execution_steps, API returns them in structured_payload."""
        from app.core.database import get_session
        from app.models.agent_conversation import AgentMessage

        conv_id = seeded_project["conversation_id"]

        # Insert message with execution_steps via direct DB access
        dep = client.app.dependency_overrides[get_session]
        session = next(dep())
        try:
            msg = AgentMessage(
                conversation_id=conv_id,
                role="assistant",
                content="测试回答",
            )
            msg.set_structured_payload({
                "next_suggestions": ["下一步做什么？"],
                "suggestions": [],
                "execution_steps": [
                    {"tool_name": "get_workspace_state", "status": "completed", "label": "调用get_workspace_state"},
                    {"tool_name": "create_risk", "status": "completed", "label": "调用create_risk"},
                ],
            })
            session.add(msg)
            session.commit()
        finally:
            session.close()

        # Fetch conversation
        resp = client.get(f"/api/projects/{seeded_project['project_id']}/agent-conversation")
        assert resp.status_code == 200
        messages = resp.json()["messages"]
        assistant_msgs = [m for m in messages if m["role"] == "assistant"]
        assert len(assistant_msgs) >= 1
        last_msg = assistant_msgs[-1]
        assert "execution_steps" in last_msg["structured_payload"]
        steps = last_msg["structured_payload"]["execution_steps"]
        assert len(steps) == 2
        assert steps[0]["tool_name"] == "get_workspace_state"
        assert steps[0]["label"] == "调用get_workspace_state"

    def test_content_is_final_answer_not_accumulated(self, client, seeded_project):
        """API returns final answer as content, not accumulated toolcall text."""
        from app.core.database import get_session
        from app.models.agent_conversation import AgentMessage

        conv_id = seeded_project["conversation_id"]

        dep = client.app.dependency_overrides[get_session]
        session = next(dep())
        try:
            msg = AgentMessage(
                conversation_id=conv_id,
                role="assistant",
                content="项目方向已明确，建议进入阶段规划。",
            )
            msg.set_structured_payload({"next_suggestions": [], "suggestions": []})
            session.add(msg)
            session.commit()
        finally:
            session.close()

        resp = client.get(f"/api/projects/{seeded_project['project_id']}/agent-conversation")
        messages = resp.json()["messages"]
        assistant_msgs = [m for m in messages if m["role"] == "assistant"]
        last_msg = assistant_msgs[-1]
        assert last_msg["content"] == "项目方向已明确，建议进入阶段规划。"
        assert "toolCall" not in last_msg["content"]
