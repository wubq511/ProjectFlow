"""Tests for T41 Internal Agent Tools API (S5).

Validates the unified internal contract:
- POST /internal/agent-tools/workspace-state
- POST /internal/agent-tools/conversation
- POST /internal/agent-tools/pending-proposals
- POST /internal/agent-tools/timeline-slice

Each returns a ProjectFlowToolResult with side_effect_status=no_side_effect.
Read-only tools must not mutate Primary Project State.
"""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy.pool import StaticPool

from app.main import app
from app.models import AgentEvent, AgentProposal, Project, User, Workspace, WorkspaceMembership
from app.models.enums import AgentEventType, AgentProposalStatus
from app.core.database import get_session


@pytest.fixture
def test_engine():
    import app.models  # noqa: F401

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


@pytest.fixture
def client(test_engine):
    from contextlib import asynccontextmanager
    from fastapi import FastAPI

    def override_get_session():
        with Session(test_engine) as session:
            yield session

    @asynccontextmanager
    async def noop_lifespan(_: FastAPI):
        yield

    app.router.lifespan_context = noop_lifespan
    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _seed(test_engine) -> dict:
    """Seed a workspace/project/user + one pending + one confirmed proposal + one timeline event."""
    with Session(test_engine) as session:
        session.add(User(id="u1", display_name="小林"))
        session.add(Workspace(id="ws1", name="测试工作区", owner_user_id="u1"))
        session.add(WorkspaceMembership(workspace_id="ws1", user_id="u1", role="owner"))
        session.add(
            Project(
                id="p1",
                workspace_id="ws1",
                name="测试项目",
                idea="做一个 demo",
                deadline="2026-08-01",
                deliverables="演示闭环",
                created_by="u1",
            )
        )
        # Timeline event
        event = AgentEvent(
            project_id="p1",
            workspace_id="ws1",
            event_type=AgentEventType.plan,
            reasoning_summary="生成阶段计划",
        )
        session.add(event)
        session.flush()
        # Two proposals: one pending, one confirmed — pending-proposals must return only the pending one
        session.add(
            AgentProposal(
                id="prop_pending",
                project_id="p1",
                workspace_id="ws1",
                proposal_type="plan",
                status=AgentProposalStatus.pending,
                agent_event_id=event.id,
                payload='{"summary":"pending plan"}',
            )
        )
        session.add(
            AgentProposal(
                id="prop_confirmed",
                project_id="p1",
                workspace_id="ws1",
                proposal_type="plan",
                status=AgentProposalStatus.confirmed,
                agent_event_id=event.id,
                payload='{"summary":"confirmed plan"}',
            )
        )
        session.commit()
        event_id = event.id
    return {"event_id": event_id}


def _envelope(tool_name: str, arguments: dict | None = None) -> dict:
    return {
        "run_id": "run_test",
        "tool_call_id": "call_test",
        "conversation_id": "conv_test",
        "workspace_id": "ws1",
        "project_id": "p1",
        "tool_name": tool_name,
        "tool_version": 1,
        "manifest_version": 1,
        "idempotency_key": "run_test:call_test:v1",
        "arguments": arguments or {},
        "client_event_id": "run_test:call_test:request",
        "ordering_hint": 0,
        "trace": {"run_id": "run_test", "tool_call_id": "call_test", "tool_name": tool_name},
    }


class TestInternalAgentTools:
    def test_workspace_state_tool(self, client, test_engine):
        _seed(test_engine)
        resp = client.post("/internal/agent-tools/workspace-state", json=_envelope("workspace-state", {"workspace_id": "ws1"}))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "no_side_effect"
        assert data["data"]["workspace_id"] == "ws1"

    def test_dispatch_uses_path_tool_name_when_envelope_uses_manifest_name(self, client, test_engine):
        _seed(test_engine)
        envelope = _envelope("get_workspace_state", {"workspace_id": "ws1"})
        resp = client.post("/internal/agent-tools/workspace-state", json=envelope)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "no_side_effect"
        assert data["data"]["workspace_id"] == "ws1"

    def test_conversation_tool(self, client, test_engine):
        _seed(test_engine)
        resp = client.post("/internal/agent-tools/conversation", json=_envelope("conversation", {"project_id": "p1"}))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "no_side_effect"

    def test_pending_proposals_returns_only_pending(self, client, test_engine):
        _seed(test_engine)
        resp = client.post(
            "/internal/agent-tools/pending-proposals",
            json=_envelope("pending-proposals", {"project_id": "p1"}),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        items = data["data"]["items"]
        assert len(items) == 1
        assert items[0]["id"] == "prop_pending"
        assert items[0]["status"] == "pending"

    def test_timeline_slice_tool(self, client, test_engine):
        _seed(test_engine)
        resp = client.post(
            "/internal/agent-tools/timeline-slice",
            json=_envelope("timeline-slice", {"project_id": "p1", "limit": 20}),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        items = data["data"]["items"]
        assert len(items) == 1
        assert items[0]["event_type"] == "plan"

    def test_timeline_slice_event_types_filter(self, client, test_engine):
        _seed(test_engine)
        resp = client.post(
            "/internal/agent-tools/timeline-slice",
            json=_envelope("timeline-slice", {"project_id": "p1", "event_types": ["checkin"]}),
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["data"]["items"]
        assert items == []

    def test_unknown_tool_returns_404(self, client, test_engine):
        _seed(test_engine)
        resp = client.post("/internal/agent-tools/no-such-tool", json=_envelope("no-such-tool"))
        assert resp.status_code == 404

    def test_workspace_not_found_returns_failed_result(self, client, test_engine):
        # No seed → workspace does not exist
        resp = client.post(
            "/internal/agent-tools/workspace-state",
            json=_envelope("workspace-state", {"workspace_id": "missing"}),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "failed"
        assert data["side_effect_status"] == "no_side_effect"

    def test_replan_proposal_tool_creates_pending_replan_proposal(self, client, test_engine):
        _seed(test_engine)
        envelope = _envelope(
            "generate_replan_proposal",
            {"project_id": "p1", "user_instruction": "根据最新签到和风险生成计划调整草案。"},
        )
        resp = client.post("/internal/agent-tools/replan-proposal", json=envelope)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None
        assert data["idempotency_key"] == "run_test:call_test:v1"

        proposal_resp = client.get(f"/api/agent-proposals/{data['links']['proposal_id']}")
        assert proposal_resp.status_code == 200, proposal_resp.text
        proposal = proposal_resp.json()
        assert proposal["proposal_type"] == "replan"
        assert proposal["status"] == "pending"
        assert proposal["payload"]["requires_confirmation"] is True

    def test_replan_proposal_tool_reuses_same_proposal_for_idempotency_key(self, client, test_engine):
        _seed(test_engine)
        envelope = _envelope(
            "generate_replan_proposal",
            {"project_id": "p1", "user_instruction": "根据最新签到和风险生成计划调整草案。"},
        )

        first = client.post("/internal/agent-tools/replan-proposal", json=envelope)
        second = client.post("/internal/agent-tools/replan-proposal", json=envelope)

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        first_data = first.json()
        second_data = second.json()
        assert first_data["links"]["proposal_id"] == second_data["links"]["proposal_id"]

        proposals_resp = client.get("/api/agent-proposals", params={"project_id": "p1", "proposal_type": "replan"})
        assert proposals_resp.status_code == 200, proposals_resp.text
        assert [p["id"] for p in proposals_resp.json()] == [first_data["links"]["proposal_id"]]


class TestPublicProposalStatusFilter:
    """The public /api/agent-proposals route must honor status=pending (previously silently ignored)."""

    def test_status_filter_excludes_confirmed(self, client, test_engine):
        _seed(test_engine)
        resp = client.get("/api/agent-proposals", params={"project_id": "p1", "status": "pending"})
        assert resp.status_code == 200, resp.text
        items = resp.json()
        assert len(items) == 1
        assert items[0]["status"] == "pending"

    def test_no_status_filter_returns_all(self, client, test_engine):
        _seed(test_engine)
        resp = client.get("/api/agent-proposals", params={"project_id": "p1"})
        assert resp.status_code == 200, resp.text
        assert len(resp.json()) == 2
