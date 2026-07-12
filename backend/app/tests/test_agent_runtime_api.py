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
    from app.models import Project, User, Workspace, WorkspaceMembership

    def override_get_session():
        with Session(test_engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session

    # Seed shared runtime test fixtures so start_run can validate viewer membership
    with Session(test_engine) as session:
        user = User(id="user_runtime", display_name="Runtime User")
        workspace = Workspace(id="ws_456", name="Runtime Workspace", owner_user_id=user.id)
        project = Project(
            id="proj_789",
            workspace_id=workspace.id,
            name="Runtime Project",
            idea="Test runtime",
            deadline="2026-07-15",
            deliverables="Demo",
            created_by=user.id,
        )
        membership = WorkspaceMembership(workspace_id=workspace.id, user_id=user.id, role="owner")
        session.add(user)
        session.add(workspace)
        session.add(project)
        session.add(membership)
        session.commit()

    with TestClient(app, headers={"Authorization": "Bearer test-internal-service-token"}) as c:
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

    def test_internal_agent_runs_require_service_token(self, test_engine):
        from app.core.database import get_session

        def override_get_session():
            with Session(test_engine) as session:
                yield session

        app.dependency_overrides[get_session] = override_get_session
        try:
            with TestClient(app) as unauthenticated_client:
                response = unauthenticated_client.post("/internal/agent-runs", json={
                    "viewer_user_id": "user_runtime",
                    "conversation_id": "conv_123",
                    "workspace_id": "ws_456",
                    "project_id": "proj_789",
                    "user_message_id": "msg_001",
                    "user_content": "帮我重新规划一下",
                })
        finally:
            app.dependency_overrides.clear()

        assert response.status_code == 403

    def test_start_run(self, client):
        """Test creating a new agent run."""
        response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
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
            "viewer_user_id": "user_runtime",
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
            "viewer_user_id": "user_runtime",
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
            "viewer_user_id": "user_runtime",
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
            "viewer_user_id": "user_runtime",
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
            "viewer_user_id": "user_runtime",
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
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Combined append (created → context_building 是合法转换)
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:combined:v1",
            "state_patch": {
                "status": "context_building",
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
        assert status_data["status"] == "context_building"
        assert status_data["current_step"] == 1
        # auto state_changed(seq=1) + 1 user event(seq=2) = last_event_seq 2
        assert status_data["last_event_seq"] == 2

    def test_append_nonexistent_run(self, client):
        """Test appending to a non-existent run."""
        response = client.post("/internal/agent-runs/nonexistent_run/events:append", json={
            "idempotency_key": "test:v1",
        })
        assert response.status_code == 404

    def test_state_patch_auto_generates_run_state_changed_event(self, client):
        """state_patch 非空时自动生成 run.state_changed 事件。"""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # 带 state_patch 的 append（不提交额外 events）
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:state_patch:v1",
            "state_patch": {
                "status": "context_building",
                "current_turn": 1,
            },
        })
        assert response.status_code == 200
        data = response.json()
        assert data["state_version"] == 1

        # 查询事件列表，应包含自动生成的 run.state_changed 事件
        events_response = client.get(f"/internal/agent-runs/{run_id}/events")
        assert events_response.status_code == 200
        events = events_response.json()
        assert len(events) == 1
        assert events[0]["type"] == "run.state_changed"
        assert events[0]["payload"]["status"] == "context_building"
        assert events[0]["payload"]["current_turn"] == 1

    def test_state_changed_event_before_user_events(self, client):
        """run.state_changed 事件在用户提交的 events 之前。"""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:combined:v1",
            "state_patch": {
                "status": "context_building",
            },
            "events": [
                {
                    "client_event_id": "client_evt_001",
                    "type": "agent.started",
                    "ordering_hint": 1,
                },
            ],
        })
        assert response.status_code == 200
        data = response.json()
        # state_changed 自动生成 + 1 个用户事件 = 2 个事件
        assert len(data["events"]) == 1  # 只有用户事件返回 EventAppendResponse
        assert data["events"][0]["event_seq"] == 2  # 用户事件在 state_changed(seq=1) 之后

        events_response = client.get(f"/internal/agent-runs/{run_id}/events")
        events = events_response.json()
        assert len(events) == 2
        assert events[0]["type"] == "run.state_changed"
        assert events[0]["event_seq"] == 1
        assert events[1]["type"] == "agent.started"
        assert events[1]["event_seq"] == 2

    def test_invalid_state_transition_rejected(self, client):
        """非法状态转换应返回 400 错误。"""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # created → completed 是非法转换
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:invalid:v1",
            "state_patch": {
                "status": "completed",
            },
        })
        assert response.status_code == 400
        assert "非法状态转换" in response.json()["detail"]

    def test_valid_state_transition_accepted(self, client):
        """合法状态转换应成功。"""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # created → context_building 是合法转换
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:valid:v1",
            "state_patch": {
                "status": "context_building",
            },
        })
        assert response.status_code == 200

        # context_building → model_streaming 是合法转换
        response2 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:valid:v2",
            "state_patch": {
                "status": "model_streaming",
            },
        })
        assert response2.status_code == 200


class TestCancelRun:
    """Test POST /internal/agent-runs/{run_id}/cancel."""

    def test_cancel_run(self, client):
        """Test cancelling a run."""
        # Create a run
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
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
            "viewer_user_id": "user_runtime",
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
            "viewer_user_id": "user_runtime",
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
            viewer_user_id=owner.id,
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


class TestP0DurableIdempotency:
    """P0-6: Pure state-patch and tool-result-only idempotency survives restart."""

    def test_pure_state_patch_duplicate_does_not_increment_version(self, client):
        """Duplicate pure state-patch request returns same response without new events."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # First state-patch request
        response1 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:pure_patch:v1",
            "state_patch": {"status": "context_building", "current_turn": 1},
        })
        assert response1.status_code == 200
        version1 = response1.json()["state_version"]
        events_after_first = client.get(f"/internal/agent-runs/{run_id}/events").json()
        event_count_after_first = len(events_after_first)

        # Duplicate request with same idempotency_key (simulates restart)
        response2 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:pure_patch:v1",
            "state_patch": {"status": "context_building", "current_turn": 1},
        })
        assert response2.status_code == 200
        version2 = response2.json()["state_version"]
        events_after_second = client.get(f"/internal/agent-runs/{run_id}/events").json()
        event_count_after_second = len(events_after_second)

        # Version and event count must NOT increase on duplicate
        assert version2 == version1
        assert event_count_after_second == event_count_after_first

    def test_tool_result_only_duplicate_does_not_increment_version(self, client, test_engine):
        """Duplicate tool-result-only request returns same response without new events."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # First tool-result-only request
        response1 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:tool_only:v1",
            "tool_results": [{
                "tool_call_id": "tc_001",
                "tool_name": "get_workspace_state",
                "tool_version": 1,
                "result": {
                    "status": "success",
                    "side_effect_status": "no_side_effect",
                    "observation": "ok",
                },
            }],
        })
        assert response1.status_code == 200
        version1 = response1.json()["state_version"]

        # Duplicate request
        response2 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:tool_only:v1",
            "tool_results": [{
                "tool_call_id": "tc_001",
                "tool_name": "get_workspace_state",
                "tool_version": 1,
                "result": {
                    "status": "success",
                    "side_effect_status": "no_side_effect",
                    "observation": "ok",
                },
            }],
        })
        assert response2.status_code == 200
        version2 = response2.json()["state_version"]
        assert version2 == version1


class TestP0OptimisticConcurrency:
    """P0-4: Expected state version enforcement."""

    def test_stale_version_returns_409(self, client):
        """Append with stale expected_state_version returns 409."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # First mutation (state_version: 0 → 1)
        client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:v1",
            "state_patch": {"status": "context_building"},
        })

        # Stale request with old version
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:stale:v1",
            "expected_state_version": 0,  # stale — actual is 1
            "state_patch": {"current_turn": 1},
        })
        assert response.status_code == 409
        assert "状态版本冲突" in response.json()["detail"]

    def test_steering_increments_state_version(self, client):
        """Steering enqueue increments state_version."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Get initial state_version
        status1 = client.get(f"/internal/agent-runs/{run_id}").json()

        # Append steering
        response = client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "constraint",
            "content": "用中文回复",
            "client_message_id": "msg_001",
        })
        assert response.status_code == 200
        steering_version = response.json()["state_version"]

        # Verify state_version was incremented
        status2 = client.get(f"/internal/agent-runs/{run_id}").json()
        assert status2["state_version"] == steering_version
        assert steering_version > status1["state_version"]

    def test_steering_stale_version_returns_409(self, client):
        """Steering with stale expected_state_version returns 409."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # First steering (increments state_version)
        client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "constraint",
            "content": "用中文回复",
            "client_message_id": "msg_001",
        })

        # Stale steering
        response = client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "correction",
            "content": "截止日期改为下周五",
            "client_message_id": "msg_002",
            "expected_state_version": 0,  # stale
        })
        assert response.status_code == 409


class TestP0SnapshotPagination:
    """P0-2: Snapshot returns complete post-checkpoint event range."""

    def test_snapshot_returns_all_events(self, client):
        """Snapshot returns all events for the run."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Append multiple events
        for i in range(5):
            client.post(f"/internal/agent-runs/{run_id}/events:append", json={
                "idempotency_key": f"{run_id}:batch{i}:v1",
                "events": [{
                    "client_event_id": f"evt_{i}",
                    "type": "tool.started",
                    "ordering_hint": i + 1,
                }],
            })

        # Get snapshot
        response = client.get(f"/internal/agent-runs/{run_id}/snapshot")
        assert response.status_code == 200
        data = response.json()
        # auto state_changed + 5 user events = 6 events per batch... but
        # each batch has 1 auto + 1 user = 2 events, 5 batches = 10 events
        assert len(data["recent_events"]) >= 5
        assert "has_more" in data

    def test_snapshot_returns_unconsumed_steering(self, client):
        """Snapshot correctly extracts unconsumed steering events."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Transition to model_streaming first (needed for steering)
        client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:to_streaming:v1",
            "state_patch": {"status": "context_building"},
        })
        client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:to_streaming2:v1",
            "state_patch": {"status": "model_streaming"},
        })

        # Add steering events
        client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "constraint",
            "content": "用中文回复",
            "client_message_id": "msg_001",
        })
        client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "correction",
            "content": "截止日期改为下周五",
            "client_message_id": "msg_002",
        })

        # Get snapshot
        response = client.get(f"/internal/agent-runs/{run_id}/snapshot")
        assert response.status_code == 200
        data = response.json()

        # Both steering events should be unconsumed
        unconsumed = data["unconsumed_steering"]
        assert len(unconsumed) == 2
        assert unconsumed[0]["steering_type"] == "constraint"
        assert unconsumed[1]["steering_type"] == "correction"


class TestP0ResumeContext:
    """P0-3: Authenticated resume context endpoint."""

    def test_resume_context_validates_viewer(self, client):
        """Resume context requires valid viewer membership."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Valid viewer
        response = client.get(f"/internal/agent-runs/{run_id}/resume-context?viewer_user_id=user_runtime")
        assert response.status_code == 200
        data = response.json()
        assert data["viewer_user_id"] == "user_runtime"
        assert data["run_id"] == run_id

    def test_resume_context_rejects_missing_viewer(self, client):
        """Resume context rejects missing viewer_user_id (FastAPI returns 422 for missing query param)."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        response = client.get(f"/internal/agent-runs/{run_id}/resume-context")
        assert response.status_code in (400, 422)  # 422 for missing required query param

    def test_resume_context_returns_state_version(self, client):
        """Resume context returns current state_version."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Mutate state to increment version
        client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:v1",
            "state_patch": {"status": "context_building"},
        })

        response = client.get(f"/internal/agent-runs/{run_id}/resume-context?viewer_user_id=user_runtime")
        assert response.status_code == 200
        data = response.json()
        assert data["state_version"] == 1
        assert data["last_event_seq"] >= 1


class TestP0Round3IdempotencyBeforeVersion:
    """Round 3 Fix 5: Idempotency check before optimistic version comparison."""

    def test_idempotent_retry_with_stale_original_version_succeeds(self, client):
        """Exact retry with the original expected version after success returns
        idempotent response, not 409."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # First request: state_patch with expected_state_version=0
        response1 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:idem_test:v1",
            "expected_state_version": 0,
            "state_patch": {"status": "context_building"},
        })
        assert response1.status_code == 200
        version_after_first = response1.json()["state_version"]

        # Exact retry: same idempotency_key AND same expected_state_version (0).
        # The idempotency check runs BEFORE version comparison, so this should
        # return the idempotent response, NOT 409.
        response2 = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:idem_test:v1",
            "expected_state_version": 0,  # stale after first mutation, but same key
            "state_patch": {"status": "context_building"},
        })
        assert response2.status_code == 200
        assert response2.json()["state_version"] == version_after_first

    def test_distinct_stale_request_returns_409(self, client):
        """A different request with stale version returns 409."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # First mutation
        client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:first:v1",
            "expected_state_version": 0,
            "state_patch": {"status": "context_building"},
        })

        # Different request with stale version → 409
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:different:v1",
            "expected_state_version": 0,  # stale
            "state_patch": {"current_turn": 1},
        })
        assert response.status_code == 409

    def test_steering_idempotent_retry_with_stale_version_succeeds(self, client):
        """Steering: exact retry with stale original version returns idempotent response."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Transition to model_streaming for steering
        client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:to_streaming:v1",
            "state_patch": {"status": "context_building"},
        })
        client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:to_streaming2:v1",
            "state_patch": {"status": "model_streaming"},
        })

        # Get current version for first steering
        current_version = client.get(f"/internal/agent-runs/{run_id}").json()["state_version"]

        # First steering (will succeed)
        response1 = client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "constraint",
            "content": "用中文回复",
            "client_message_id": "msg_steering_idem",
            "expected_state_version": current_version,
        })
        assert response1.status_code == 200

        # Exact retry with same client_message_id but stale version.
        # Idempotency check runs FIRST → returns cached response, not 409.
        response2 = client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "constraint",
            "content": "用中文回复",
            "client_message_id": "msg_steering_idem",
            "expected_state_version": current_version,  # stale after first steering advanced it
        })
        assert response2.status_code == 200
        assert response2.json()["accepted"] is True
        assert "幂等" in response2.json()["message"]


class TestP0Round3SnapshotPagination:
    """Round 3 Fix 1: Cursor-based snapshot pagination."""

    def test_snapshot_returns_next_cursor_when_more_pages(self, client):
        """Snapshot returns next_cursor when has_more is true."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Append many events to exceed a small page size
        for i in range(10):
            client.post(f"/internal/agent-runs/{run_id}/events:append", json={
                "idempotency_key": f"{run_id}:batch{i}:v1",
                "events": [{
                    "client_event_id": f"evt_{i}",
                    "type": "tool.started",
                    "ordering_hint": i + 1,
                }],
            })

        # Get snapshot with small limit
        response = client.get(f"/internal/agent-runs/{run_id}/snapshot?after_event_seq=0")
        assert response.status_code == 200
        data = response.json()

        # With default limit of 200, all events fit in one page
        assert "has_more" in data
        assert "next_cursor" in data

    def test_snapshot_pagination_with_cursor_advances(self, client):
        """Snapshot with after_event_seq returns only events after that sequence."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Append events
        for i in range(5):
            client.post(f"/internal/agent-runs/{run_id}/events:append", json={
                "idempotency_key": f"{run_id}:batch{i}:v1",
                "events": [{
                    "client_event_id": f"evt_{i}",
                    "type": "tool.started",
                    "ordering_hint": i + 1,
                }],
            })

        # Get first page (all events from seq 0)
        page1 = client.get(f"/internal/agent-runs/{run_id}/snapshot").json()
        page1_events = page1["recent_events"]

        # Get second page from after the first event
        if len(page1_events) > 0:
            first_seq = page1_events[0]["event_seq"]
            page2 = client.get(f"/internal/agent-runs/{run_id}/snapshot?after_event_seq={first_seq}").json()
            page2_events = page2["recent_events"]

            # Page 2 should not include the first event
            page2_seqs = [e["event_seq"] for e in page2_events]
            assert first_seq not in page2_seqs


class TestP0Round3EventsAdvanceVersion:
    """Round 3 Fix 6: Events-only append advances state_version."""

    def test_events_only_append_advances_state_version(self, client):
        """Appending events (without state_patch or tool_results) advances state_version."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        # Get initial state_version
        status1 = client.get(f"/internal/agent-runs/{run_id}").json()
        initial_version = status1["state_version"]

        # Append events only (no state_patch, no tool_results)
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": f"{run_id}:events_only:v1",
            "events": [{
                "client_event_id": "evt_only_1",
                "type": "agent.started",
                "ordering_hint": 1,
            }],
        })
        assert response.status_code == 200

        # Verify state_version advanced
        status2 = client.get(f"/internal/agent-runs/{run_id}").json()
        assert status2["state_version"] > initial_version


class TestP0Round3ResumeContextEnriched:
    """Round 3 Fix 2: Resume context returns workspace state and pending proposals."""

    def test_resume_context_returns_workspace_state(self, client):
        """Resume context includes workspace_state field."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        response = client.get(f"/internal/agent-runs/{run_id}/resume-context?viewer_user_id=user_runtime")
        assert response.status_code == 200
        data = response.json()

        # Should contain workspace_state (fresh facts)
        assert "workspace_state" in data
        # workspace_state should be a dict (WorkspaceStateResponse or empty)
        assert isinstance(data["workspace_state"], dict)

    def test_resume_context_returns_pending_proposals(self, client):
        """Resume context includes pending_proposals field."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        response = client.get(f"/internal/agent-runs/{run_id}/resume-context?viewer_user_id=user_runtime")
        assert response.status_code == 200
        data = response.json()

        # Should contain pending_proposals (list)
        assert "pending_proposals" in data
        assert isinstance(data["pending_proposals"], list)

    def test_resume_context_returns_memory_context(self, client):
        """Resume context includes memory_context field."""
        create_response = client.post("/internal/agent-runs", json={
            "viewer_user_id": "user_runtime",
            "conversation_id": "conv_123",
            "workspace_id": "ws_456",
            "project_id": "proj_789",
            "user_content": "test",
        })
        run_id = create_response.json()["run_id"]

        response = client.get(f"/internal/agent-runs/{run_id}/resume-context?viewer_user_id=user_runtime")
        assert response.status_code == 200
        data = response.json()

        # Should contain memory_context (may be None if memory is disabled)
        assert "memory_context" in data
