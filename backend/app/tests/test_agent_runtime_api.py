"""Tests for T41 Agent Runtime API (S2).

Validates:
- POST /internal/agent-runs — create run
- GET /internal/agent-runs/{run_id} — get status
- POST /internal/agent-runs/{run_id}/events:append — atomic append
- POST /internal/agent-runs/{run_id}/cancel — cancel run
- Idempotency key handling
- Event sequence assignment
"""

import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine
from sqlalchemy.pool import StaticPool

from app.main import app
from app.models import AgentEvent, AgentProposal, Project, User, Workspace
from app.models.agent_run_state import AgentRunV2
from app.models.enums import (
    AgentEventStatus,
    AgentEventType,
    AgentProposalStatus,
    AgentRunStatus,
)


@pytest.fixture
def test_engine():
    """Create test engine with in-memory database."""
    # Import all models to ensure they're registered with SQLModel metadata
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
    """Create test client with test database."""
    from app.core.database import get_session

    def override_get_session():
        with Session(test_engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def db_session():
    """Get database session."""
    from app.core.database import engine
    from sqlmodel import Session
    with Session(engine) as session:
        yield session


class TestStartAgentRun:
    """Test POST /internal/agent-runs."""

    def test_start_run(self, client):
        """Test creating a new agent run."""
        response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_message_id": "msg_001",
            "user_content": "帮我重新规划一下",
        })
        assert response.status_code == 200
        data = response.json()
        assert "run_id" in data
        assert data["status"] == "created"


class TestGetRunStatus:
    """Test GET /internal/agent-runs/{run_id}."""

    def test_get_existing_run(self, client):
        """Test getting status of an existing run."""
        # Create a run first
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Get status
        response = client.get(f"/internal/agent-runs/{run_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["run_id"] == run_id
        assert data["status"] == "created"
        assert data["current_turn"] == 0
        assert data["current_step"] == 0
        assert data["last_event_seq"] == 0

    def test_get_nonexistent_run(self, client):
        """Test getting status of a non-existent run."""
        response = client.get("/internal/agent-runs/nonexistent_run")
        assert response.status_code == 404


class TestAppendEvents:
    """Test POST /internal/agent-runs/{run_id}/events:append."""

    def test_append_state_patch(self, client):
        """Test appending a state patch."""
        # Create a run
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Append state patch
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:state_update:v1",
            "state_patch": {
                "status": "context_building",
                "current_turn": 1,
            },
        })
        assert response.status_code == 200
        data = response.json()
        assert data["state_version"] == 1
        assert data["events"] == []
        assert data["tool_results"] == []

        # Verify state was updated
        status_response = client.get(f"/internal/agent-runs/{run_id}")
        status_data = status_response.json()
        assert status_data["status"] == "context_building"
        assert status_data["current_turn"] == 1

    def test_append_events(self, client):
        """Test appending events."""
        # Create a run
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Append events
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:events:v1",
            "events": [
                {
                    "client_event_id": "client_evt_001",
                    "type": "tool.started",
                    "ordering_hint": 1,
                    "payload": {"tool_name": "get_workspace_state"},
                },
                {
                    "client_event_id": "client_evt_002",
                    "type": "tool.completed",
                    "ordering_hint": 2,
                    "payload": {"tool_name": "get_workspace_state"},
                },
            ],
        })
        assert response.status_code == 200
        data = response.json()
        assert len(data["events"]) == 2
        assert data["events"][0]["event_seq"] == 1
        assert data["events"][1]["event_seq"] == 2
        assert data["events"][0]["client_event_id"] == "client_evt_001"
        assert data["events"][1]["client_event_id"] == "client_evt_002"

    def test_append_persists_runtime_events_with_trace_for_query(self, client):
        """Runtime append persists bounded event payload and trace for resume/query."""
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:agent-start:v1",
            "events": [
                {
                    "client_event_id": "client_evt_agent_start",
                    "type": "agent.started",
                    "ordering_hint": 1,
                    "payload": {
                        "run_id": run_id,
                        "conversation_id": "conv_123",
                        "workspace_id": "ws_456",
                        "project_id": "proj_789",
                        "state_schema_version": 1,
                    },
                    "trace": {
                        "run_id": run_id,
                        "conversation_id": "conv_123",
                        "workspace_id": "ws_456",
                        "project_id": "proj_789",
                        "provider": "mock",
                        "model": "mock-model",
                        "redacted": True,
                    },
                },
            ],
        })
        assert response.status_code == 200
        assert response.json()["events"][0]["event_seq"] == 1

        events_response = client.get(f"/internal/agent-runs/{run_id}/events")
        assert events_response.status_code == 200
        events = events_response.json()
        assert len(events) == 1
        assert events[0]["run_id"] == run_id
        assert events[0]["type"] == "agent.started"
        assert events[0]["event_seq"] == 1
        assert events[0]["client_event_id"] == "client_evt_agent_start"
        assert events[0]["payload"]["project_id"] == "proj_789"
        assert events[0]["trace"]["redacted"] is True

        duplicate = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:agent-start:v1",
            "events": [
                {
                    "client_event_id": "client_evt_agent_start",
                    "type": "agent.started",
                    "ordering_hint": 1,
                },
            ],
        })
        assert duplicate.status_code == 200
        assert client.get(f"/internal/agent-runs/{run_id}/events").json() == events

    def test_append_tool_results(self, client):
        """Test appending tool results."""
        # Create a run
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Append tool result
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:tool_result:v1",
            "tool_results": [
                {
                    "tool_call_id": "tc_001",
                    "tool_name": "get_workspace_state",
                    "tool_version": 1,
                    "result": {
                        "status": "success",
                        "data": {"workspace_id": "ws_456"},
                        "side_effect_status": "no_side_effect",
                        "observation": "Workspace state retrieved",
                    },
                },
            ],
        })
        assert response.status_code == 200
        data = response.json()
        assert len(data["tool_results"]) == 1
        assert data["tool_results"][0]["tool_call_id"] == "tc_001"
        assert data["tool_results"][0]["persisted"] is True

    def test_append_combined(self, client):
        """Test appending state patch, events, and tool results together."""
        # Create a run
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Combined append
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:combined:v1",
            "state_patch": {
                "status": "tool_running",
                "current_step": 1,
            },
            "events": [
                {
                    "client_event_id": "client_evt_001",
                    "type": "tool.started",
                    "ordering_hint": 1,
                },
            ],
            "tool_results": [
                {
                    "tool_call_id": "tc_001",
                    "tool_name": "create_risk",
                    "tool_version": 1,
                    "result": {
                        "status": "success",
                        "side_effect_status": "advisory_record_persisted",
                        "observation": "Risk created",
                    },
                },
            ],
        })
        assert response.status_code == 200
        data = response.json()
        assert data["state_version"] == 1
        assert len(data["events"]) == 1
        assert len(data["tool_results"]) == 1

        # Verify state
        status_response = client.get(f"/internal/agent-runs/{run_id}")
        status_data = status_response.json()
        assert status_data["status"] == "tool_running"
        assert status_data["current_step"] == 1
        assert status_data["last_event_seq"] == 1

    def test_append_nonexistent_run(self, client):
        """Test appending to a non-existent run."""
        response = client.post("/internal/agent-runs/nonexistent_run/events:append", json={
            "idempotency_key": "test:v1",
        })
        assert response.status_code == 404


class TestCancelRun:
    """Test POST /internal/agent-runs/{run_id}/cancel."""

    def test_cancel_run(self, client):
        """Test cancelling a run."""
        # Create a run
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Cancel the run
        response = client.post(f"/internal/agent-runs/{run_id}/cancel")
        assert response.status_code == 200
        data = response.json()
        assert data["run_id"] == run_id
        assert data["status"] == "cancelling"
        assert data["cancelled"] is True

        # Verify status
        status_response = client.get(f"/internal/agent-runs/{run_id}")
        status_data = status_response.json()
        assert status_data["status"] == "cancelling"

    def test_cancel_nonexistent_run(self, client):
        """Test cancelling a non-existent run."""
        response = client.post("/internal/agent-runs/nonexistent_run/cancel")
        assert response.status_code == 404


class TestEventSequenceAssignment:
    """Test that event_seq is assigned monotonically per run_id."""

    def test_monotonic_event_seq(self, client):
        """Test that event_seq increments correctly."""
        # Create a run
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Append first batch of events
        response1 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:batch1:v1",
            "events": [
                {"client_event_id": "evt_1", "type": "run.started", "ordering_hint": 1},
                {"client_event_id": "evt_2", "type": "tool.started", "ordering_hint": 2},
            ],
        })
        data1 = response1.json()
        assert data1["events"][0]["event_seq"] == 1
        assert data1["events"][1]["event_seq"] == 2

        # Append second batch of events
        response2 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:batch2:v1",
            "events": [
                {"client_event_id": "evt_3", "type": "tool.completed", "ordering_hint": 3},
                {"client_event_id": "evt_4", "type": "state.changed", "ordering_hint": 4},
            ],
        })
        data2 = response2.json()
        assert data2["events"][0]["event_seq"] == 3
        assert data2["events"][1]["event_seq"] == 4

        # Verify last_event_seq
        status_response = client.get(f"/internal/agent-runs/{run_id}")
        assert status_response.json()["last_event_seq"] == 4


class TestSideEffectsTracking:
    """Test that side effects are tracked correctly."""

    def test_side_effects_accumulate(self, client, test_engine):
        """Test that side effects accumulate across tool calls."""
        # Create a run
        create_response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # First tool result with advisory side effect
        response1 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:tool1:v1",
            "tool_results": [
                {
                    "tool_call_id": "tc_001",
                    "tool_name": "create_risk",
                    "tool_version": 1,
                    "result": {
                        "status": "success",
                        "side_effect_status": "advisory_record_persisted",
                        "observation": "Risk created",
                    },
                },
            ],
        })
        assert response1.status_code == 200

        # Second tool result with proposal side effect
        response2 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:tool2:v1",
            "tool_results": [
                {
                    "tool_call_id": "tc_002",
                    "tool_name": "create_stage_plan_proposal",
                    "tool_version": 1,
                    "result": {
                        "status": "success",
                        "side_effect_status": "proposal_persisted",
                        "observation": "Proposal created",
                    },
                },
            ],
        })
        assert response2.status_code == 200

        # Verify side effects in database using the test engine
        from sqlmodel import Session
        with Session(test_engine) as session:
            run = session.get(AgentRunV2, run_id)
            side_effects = run.get_side_effects()
            assert len(side_effects) == 2
            assert side_effects[0]["tool_call_id"] == "tc_001"
            assert side_effects[0]["status"] == "advisory_record_persisted"
            assert side_effects[1]["tool_call_id"] == "tc_002"
            assert side_effects[1]["status"] == "proposal_persisted"


class TestProposalConfirmationRuntimeEvents:
    """Proposal confirmation should emit runtime confirmation events for S10."""

    def test_confirm_proposal_records_confirmed_and_committed_runtime_events(self, client, test_engine):
        run_id, proposal_id, owner_id = _create_runtime_linked_clarify_proposal(test_engine)

        response = client.post(
            f"/api/agent-proposals/{proposal_id}/confirm",
            json={"confirmed_by": owner_id},
        )
        assert response.status_code == 200

        events_response = client.get(f"/internal/agent-runs/{run_id}/events")
        assert events_response.status_code == 200
        events = events_response.json()
        event_types = [event["type"] for event in events]
        assert event_types == [
            "proposal_confirmation.confirmed",
            "proposal_confirmation.committed",
        ]
        assert events[0]["payload"]["proposal_id"] == proposal_id
        assert events[0]["payload"]["tool_call_id"] == "call_confirm"
        assert events[0]["payload"]["tool_name"] == "generate_stage_plan_proposal"
        assert events[0]["payload"]["confirmed_by"] == owner_id
        assert events[1]["payload"]["proposal_id"] == proposal_id
        assert events[1]["payload"]["created_ids"] == ["proj_confirm"]
        assert events[1]["trace"]["tool_call_id"] == "call_confirm"

    def test_reject_proposal_records_rejected_runtime_event_only(self, client, test_engine):
        run_id, proposal_id, _owner_id = _create_runtime_linked_clarify_proposal(test_engine)

        response = client.post(
            f"/api/agent-proposals/{proposal_id}/reject",
            json={"reason": "范围暂不确认"},
        )
        assert response.status_code == 200

        events_response = client.get(f"/internal/agent-runs/{run_id}/events")
        assert events_response.status_code == 200
        events = events_response.json()
        assert [event["type"] for event in events] == ["proposal_confirmation.rejected"]
        assert events[0]["payload"]["proposal_id"] == proposal_id
        assert events[0]["payload"]["tool_call_id"] == "call_confirm"
        assert events[0]["payload"]["rejection_reason"] == "范围暂不确认"


def _create_runtime_linked_clarify_proposal(test_engine) -> tuple[str, str, str]:
    """Create a pending clarify proposal linked back to an AgentRunV2."""
    with Session(test_engine) as session:
        owner = User(id="user_confirm", display_name="Owner")
        workspace = Workspace(id="ws_confirm", name="Workspace", owner_user_id=owner.id)
        project = Project(
            id="proj_confirm",
            workspace_id=workspace.id,
            name="Project",
            idea="Test proposal confirmation runtime event",
            deadline="2026-07-15",
            deliverables="Demo",
            created_by=owner.id,
        )
        run = AgentRunV2(
            id="run_confirm",
            conversation_id="conv_confirm",
            workspace_id=workspace.id,
            project_id=project.id,
            status=AgentRunStatus.completed,
            current_turn=1,
            current_step=1,
            model_provider="mock",
            model_name="mock-model",
            side_effects="[]",
            last_event_seq=0,
            resume_manifest_version=1,
            state_version=0,
        )
        source_event = AgentEvent(
            id="agent_event_confirm",
            project_id=project.id,
            workspace_id=workspace.id,
            event_type=AgentEventType.clarify,
            status=AgentEventStatus.success,
            input_snapshot=json.dumps({
                "tool_run_id": run.id,
                "tool_call_id": "call_confirm",
                "tool_name": "generate_stage_plan_proposal",
            }, ensure_ascii=False),
            output_snapshot="{}",
            reasoning_summary="Generated clarify proposal",
        )
        proposal = AgentProposal(
            id="proposal_confirm",
            project_id=project.id,
            workspace_id=workspace.id,
            proposal_type="clarify",
            status=AgentProposalStatus.pending,
            agent_event_id=source_event.id,
            payload=json.dumps({
                "problem": "问题",
                "users": "学生团队",
                "value": "推进项目",
                "deliverables": ["演示"],
                "boundaries": [],
                "risks": [],
                "suggested_questions": [],
                "requires_confirmation": True,
                "reason": "需要确认方向",
            }, ensure_ascii=False),
        )
        session.add(owner)
        session.add(workspace)
        session.add(project)
        session.add(run)
        session.add(source_event)
        session.add(proposal)
        session.commit()
        return run.id, proposal.id, owner.id
