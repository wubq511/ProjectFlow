"""T43 P0 Correctness Production-Seam Tests.

Tests execute real AgentRuntimeService methods against a test DB — not
just constructed objects. Validates:
- P0-2: Snapshot pagination returns checkpoint + post-checkpoint events
- P0-3: Durable idempotency across service instances (DB-backed)
- P0-4: Expected state_version returns 409 on stale writes
- P0-5: Steering queue: steering.queued events, unconsumed exposure, steering.consumed
"""

import json
import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine
from sqlalchemy.pool import StaticPool

from app.main import app
from app.models import Project, User, Workspace, WorkspaceMembership
from app.models.agent_run_state import AgentRunV2, AgentRunEvent
from app.models.enums import AgentRunStatus, RuntimeEventType
from app.services.agent_runtime_service import (
    AgentRuntimeService,
    StaleStateVersionError,
)


# ─── Fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture
def test_engine():
    """Create test engine with in-memory database."""
    import app.models  # noqa: F401
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


@pytest.fixture
def seeded_session(test_engine):
    """Session with user, workspace, project, membership, and a run."""
    with Session(test_engine) as session:
        user = User(id="user_p0", display_name="P0 User")
        workspace = Workspace(id="ws_p0", name="P0 Workspace", owner_user_id=user.id)
        project = Project(
            id="proj_p0",
            workspace_id=workspace.id,
            name="P0 Project",
            idea="Test P0",
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
        yield session


@pytest.fixture
def run_with_events(seeded_session):
    """Create a run with multiple events for snapshot testing."""
    session = seeded_session
    run = AgentRunV2(
        id="run_p0_test",
        conversation_id="conv_p0",
        project_id="proj_p0",
        workspace_id="ws_p0",
        viewer_user_id="user_p0",
        status=AgentRunStatus.model_streaming,
        current_turn=1,
        current_step=2,
        model_provider="mock",
        model_name="mock-model",
        side_effects="[]",
        last_event_seq=0,
        state_version=0,
    )
    session.add(run)

    # Add events: agent.started, state_changed, tool.ledger_entry, checkpoint, more events
    events = [
        ("agent.started", 1, {"user_content": "帮我做项目规划", "skill": "project-planning"}),
        ("run.state_changed", 2, {"status": "model_streaming"}),
        ("tool.ledger_entry", 3, {
            "logical_call_id": "run_p0_test_tc-1",
            "run_id": "run_p0_test",
            "tool_call_id": "tc-1",
            "tool_name": "get_workspace_state",
            "result_status": "success",
            "side_effect_status": "no_side_effect",
        }),
        ("checkpoint.saved", 4, {
            "checkpoint": {
                "schemaVersion": 1,
                "id": "ckpt_run_p0_test_1",
                "runId": "run_p0_test",
                "transportStatus": "model_streaming",
                "workState": {"schemaVersion": 1, "status": "executing", "version": 3, "expectedVersion": 2},
                "workStateVersion": 3,
                "outcomeContractSummary": {
                    "requestType": "act",
                    "effectCeiling": "full",
                    "completionMode": "complete",
                    "verificationLevel": "deterministic",
                },
                "recoveryDecisions": [
                    {"toolName": "get_workspace_state", "toolCallId": "tc-1", "logicalCallId": "run_p0_test_tc-1", "action": "completed", "reason": "ok"},
                ],
                "contextSummary": {"skillName": "project-planning", "userContentLength": 20},
            },
        }),
        ("tool.ledger_entry", 5, {
            "logical_call_id": "run_p0_test_tc-2",
            "run_id": "run_p0_test",
            "tool_call_id": "tc-2",
            "tool_name": "generate_plan",
            "result_status": "success",
            "side_effect_status": "proposal_persisted",
        }),
        ("run.state_changed", 6, {"status": "model_streaming"}),
    ]

    for type_val, seq, payload in events:
        event = AgentRunEvent(
            run_id=run.id,
            conversation_id="conv_p0",
            workspace_id="ws_p0",
            project_id="proj_p0",
            type=RuntimeEventType(type_val),
            event_seq=seq,
            client_event_id=f"evt_{seq}",
            ordering_hint=seq,
        )
        event.set_payload(payload)
        event.set_trace({})
        session.add(event)

    run.last_event_seq = 6
    session.commit()
    session.refresh(run)
    return run


# ─── P0-2: Snapshot Pagination ────────────────────────────────────────────

class TestSnapshotPagination:
    """P0-2: get_run_snapshot returns checkpoint + all post-checkpoint events."""

    def test_snapshot_returns_checkpoint_and_post_events(self, seeded_session, run_with_events):
        """Snapshot must include checkpoint event AND all events after it."""
        service = AgentRuntimeService(seeded_session)
        snapshot = service.get_run_snapshot("run_p0_test")

        assert snapshot is not None
        assert snapshot["latest_checkpoint"] is not None
        assert snapshot["latest_checkpoint"]["id"] == "ckpt_run_p0_test_1"

        # Events should start from checkpoint_seq (4) onward
        events = snapshot["recent_events"]
        assert len(events) >= 3  # checkpoint (4) + ledger (5) + state_changed (6)
        # First event should be at or after checkpoint seq
        assert events[0]["event_seq"] >= 4

    def test_snapshot_includes_viewer_user_id(self, seeded_session, run_with_events):
        """Snapshot must include viewer_user_id for resume identity restoration."""
        service = AgentRuntimeService(seeded_session)
        snapshot = service.get_run_snapshot("run_p0_test")

        assert snapshot is not None
        assert snapshot["viewer_user_id"] == "user_p0"

    def test_snapshot_includes_model_info(self, seeded_session, run_with_events):
        """Snapshot must include model_provider and model_name."""
        service = AgentRuntimeService(seeded_session)
        snapshot = service.get_run_snapshot("run_p0_test")

        assert snapshot is not None
        assert snapshot["model_provider"] == "mock"
        assert snapshot["model_name"] == "mock-model"

    def test_snapshot_has_more_flag(self, seeded_session):
        """When events exceed limit, has_more should be True."""
        session = seeded_session
        run = AgentRunV2(
            id="run_overflow",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
        )
        session.add(run)

        # Add many events
        for i in range(250):
            event = AgentRunEvent(
                run_id=run.id,
                conversation_id="conv_p0",
                workspace_id="ws_p0",
                project_id="proj_p0",
                type=RuntimeEventType.run_state_changed,
                event_seq=i + 1,
                client_event_id=f"evt_{i}",
            )
            event.set_payload({"seq": i + 1})
            event.set_trace({})
            session.add(event)

        run.last_event_seq = 250
        session.commit()

        service = AgentRuntimeService(seeded_session)
        snapshot = service.get_run_snapshot("run_overflow", post_checkpoint_limit=100)

        assert snapshot is not None
        assert snapshot["has_more"] is True
        assert len(snapshot["recent_events"]) == 100

    def test_snapshot_no_checkpoint_returns_all_bounded(self, seeded_session):
        """Without checkpoint, returns all events (bounded)."""
        session = seeded_session
        run = AgentRunV2(
            id="run_no_ckpt",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
        )
        session.add(run)

        for i in range(5):
            event = AgentRunEvent(
                run_id=run.id,
                conversation_id="conv_p0",
                workspace_id="ws_p0",
                project_id="proj_p0",
                type=RuntimeEventType.agent_started,
                event_seq=i + 1,
                client_event_id=f"evt_{i}",
            )
            event.set_payload({"seq": i + 1})
            event.set_trace({})
            session.add(event)

        run.last_event_seq = 5
        session.commit()

        service = AgentRuntimeService(seeded_session)
        snapshot = service.get_run_snapshot("run_no_ckpt")

        assert snapshot is not None
        assert snapshot["latest_checkpoint"] is None
        assert len(snapshot["recent_events"]) == 5


# ─── P0-3: Durable Idempotency ────────────────────────────────────────────

class TestDurableIdempotency:
    """P0-3: Idempotency survives service restart (DB-backed, not in-memory)."""

    def test_duplicate_append_returns_original_result(self, seeded_session):
        """Same client_event_id returns original result without adding events."""
        service = AgentRuntimeService(seeded_session)

        # Create a run
        run = AgentRunV2(
            id="run_idempotent",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
        )
        seeded_session.add(run)
        seeded_session.commit()

        from app.schemas.runtime import AppendRequest, EventAppendItem
        from app.models.enums import RuntimeEventType

        request = AppendRequest(
            idempotency_key="key_1",
            events=[
                EventAppendItem(
                    client_event_id="unique_event_1",
                    type=RuntimeEventType.agent_started,
                    payload={"content": "test"},
                ),
            ],
        )

        # First append
        response1 = service.append_events("run_idempotent", request)
        assert len(response1.events) == 1
        seq1 = response1.events[0].event_seq

        # Second append with same client_event_id — should be idempotent
        response2 = service.append_events("run_idempotent", request)
        assert len(response2.events) == 1
        assert response2.events[0].event_seq == seq1  # Same event_seq

        # Verify only one event was persisted
        events = seeded_session.exec(
            AgentRunEvent.__table__.select().where(
                AgentRunEvent.run_id == "run_idempotent"
            )
        ).all()
        event_count = len([e for e in events if e.client_event_id == "unique_event_1"])
        assert event_count == 1

    def test_idempotency_survives_new_service_instance(self, seeded_session):
        """New service instance (simulating restart) still detects duplicates."""
        # First service instance
        service1 = AgentRuntimeService(seeded_session)

        run = AgentRunV2(
            id="run_restart",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
        )
        seeded_session.add(run)
        seeded_session.commit()

        from app.schemas.runtime import AppendRequest, EventAppendItem
        from app.models.enums import RuntimeEventType

        request = AppendRequest(
            idempotency_key="restart_key",
            events=[
                EventAppendItem(
                    client_event_id="restart_event_1",
                    type=RuntimeEventType.agent_started,
                    payload={"content": "before restart"},
                ),
            ],
        )

        response1 = service1.append_events("run_restart", request)
        seq1 = response1.events[0].event_seq

        # Simulate restart: create new service instance (new in-memory cache)
        service2 = AgentRuntimeService(seeded_session)

        # Same request on new instance should be idempotent
        response2 = service2.append_events("run_restart", request)
        assert response2.events[0].event_seq == seq1

    def test_steering_idempotency(self, seeded_session):
        """Same client_message_id returns original result."""
        service = AgentRuntimeService(seeded_session)

        run = AgentRunV2(
            id="run_steering_idem",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
        )
        seeded_session.add(run)
        seeded_session.commit()

        result1 = service.append_steering(
            "run_steering_idem", "constraint", "必须在周五前完成", "msg_123",
        )
        assert result1["accepted"] is True

        result2 = service.append_steering(
            "run_steering_idem", "constraint", "必须在周五前完成", "msg_123",
        )
        assert result2["accepted"] is True
        assert result2["message"] == "已接收（幂等）"
        assert result2["steering_seq"] == result1["steering_seq"]


# ─── P0-4: Optimistic Concurrency ─────────────────────────────────────────

class TestOptimisticConcurrency:
    """P0-4: expected_state_version returns 409 on stale writes."""

    def test_stale_version_raises_error(self, seeded_session):
        """When expected_state_version doesn't match, raise StaleStateVersionError."""
        service = AgentRuntimeService(seeded_session)

        run = AgentRunV2(
            id="run_concurrent",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
            state_version=5,
        )
        seeded_session.add(run)
        seeded_session.commit()

        from app.schemas.runtime import AppendRequest

        request = AppendRequest(
            idempotency_key="concurrent_key",
            expected_state_version=3,  # Stale!
        )

        with pytest.raises(StaleStateVersionError) as exc_info:
            service.append_events("run_concurrent", request)

        assert exc_info.value.expected == 3
        assert exc_info.value.actual == 5

    def test_matching_version_succeeds(self, seeded_session):
        """When expected_state_version matches, append succeeds."""
        service = AgentRuntimeService(seeded_session)

        run = AgentRunV2(
            id="run_matching",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
            state_version=5,
        )
        seeded_session.add(run)
        seeded_session.commit()

        from app.schemas.runtime import AppendRequest

        request = AppendRequest(
            idempotency_key="matching_key",
            expected_state_version=5,  # Matches
            state_patch={"current_step": 3},
        )

        response = service.append_events("run_matching", request)
        assert response.state_version == 6  # Incremented

    def test_steering_stale_version_raises_error(self, seeded_session):
        """Steering with stale expected_state_version raises error."""
        service = AgentRuntimeService(seeded_session)

        run = AgentRunV2(
            id="run_steering_stale",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
            state_version=3,
        )
        seeded_session.add(run)
        seeded_session.commit()

        with pytest.raises(StaleStateVersionError):
            service.append_steering(
                "run_steering_stale", "constraint", "test", "msg_stale",
                expected_state_version=1,
            )


# ─── P0-5: Steering Queue End-to-End ─────────────────────────────────────

class TestSteeringQueue:
    """P0-5: steering.queued events, unconsumed exposure, steering.consumed."""

    def test_steering_creates_queued_event(self, seeded_session):
        """Steering must persist as steering.queued, not run_state_changed."""
        service = AgentRuntimeService(seeded_session)

        run = AgentRunV2(
            id="run_steering_queue",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
        )
        seeded_session.add(run)
        seeded_session.commit()

        service.append_steering(
            "run_steering_queue", "constraint", "必须在周五前完成", "msg_queue_1",
        )

        # Verify event type is steering.queued
        events = seeded_session.exec(
            AgentRunEvent.__table__.select().where(
                AgentRunEvent.run_id == "run_steering_queue"
            )
        ).all()
        steering_events = [e for e in events if e.client_event_id == "steering:msg_queue_1"]
        assert len(steering_events) == 1
        assert steering_events[0].type == RuntimeEventType.steering_queued

        # Verify payload
        payload = json.loads(steering_events[0].payload)
        assert payload["steering_type"] == "constraint"
        assert payload["content"] == "必须在周五前完成"
        assert payload["client_message_id"] == "msg_queue_1"

    def test_snapshot_exposes_unconsumed_steering(self, seeded_session, run_with_events):
        """Snapshot must include unconsumed steering events."""
        session = seeded_session

        # Add a steering.queued event to the run
        steering = AgentRunEvent(
            run_id="run_p0_test",
            conversation_id="conv_p0",
            workspace_id="ws_p0",
            project_id="proj_p0",
            type=RuntimeEventType.steering_queued,
            event_seq=7,
            client_event_id="steering:msg_snap_1",
        )
        steering.set_payload({
            "steering_type": "correction",
            "content": "改为使用 TypeScript",
            "client_message_id": "msg_snap_1",
            "metadata": {},
        })
        steering.set_trace({})
        session.add(steering)
        session.commit()

        service = AgentRuntimeService(seeded_session)
        snapshot = service.get_run_snapshot("run_p0_test")

        assert len(snapshot["unconsumed_steering"]) == 1
        assert snapshot["unconsumed_steering"][0]["steering_type"] == "correction"
        assert snapshot["unconsumed_steering"][0]["content"] == "改为使用 TypeScript"

    def test_steering_consumed_removes_from_unconsumed(self, seeded_session):
        """steering.consumed event removes the item from unconsumed queue."""
        session = seeded_session

        run = AgentRunV2(
            id="run_consumed",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.model_streaming,
            side_effects="[]",
        )
        session.add(run)

        # Add steering.queued
        queued = AgentRunEvent(
            run_id="run_consumed",
            conversation_id="conv_p0",
            workspace_id="ws_p0",
            project_id="proj_p0",
            type=RuntimeEventType.steering_queued,
            event_seq=1,
            client_event_id="steering:msg_c1",
        )
        queued.set_payload({"steering_type": "constraint", "content": "test", "client_message_id": "msg_c1"})
        queued.set_trace({})
        session.add(queued)

        # Add steering.consumed
        consumed = AgentRunEvent(
            run_id="run_consumed",
            conversation_id="conv_p0",
            workspace_id="ws_p0",
            project_id="proj_p0",
            type=RuntimeEventType.steering_consumed,
            event_seq=2,
            client_event_id="consumed:msg_c1",
        )
        consumed.set_payload({"steering_seq": 1})
        consumed.set_trace({})
        session.add(consumed)
        session.commit()

        service = AgentRuntimeService(seeded_session)
        snapshot = service.get_run_snapshot("run_consumed")

        assert len(snapshot["unconsumed_steering"]) == 0

    def test_terminal_run_rejects_steering(self, seeded_session):
        """Steering on a terminal run raises ValueError."""
        service = AgentRuntimeService(seeded_session)

        run = AgentRunV2(
            id="run_terminal",
            conversation_id="conv_p0",
            project_id="proj_p0",
            workspace_id="ws_p0",
            viewer_user_id="user_p0",
            status=AgentRunStatus.completed,
            side_effects="[]",
        )
        seeded_session.add(run)
        seeded_session.commit()

        with pytest.raises(ValueError, match="already completed"):
            service.append_steering(
                "run_terminal", "constraint", "test", "msg_terminal",
            )


# ─── HTTP Route Integration ───────────────────────────────────────────────

class TestRuntimeRoutes:
    """Test the HTTP routes return correct status codes for P0 scenarios."""

    @pytest.fixture
    def client(self, test_engine):
        """Create test client with test database."""
        from app.core.database import get_session

        def override_get_session():
            with Session(test_engine) as session:
                yield session

        app.dependency_overrides[get_session] = override_get_session

        with Session(test_engine) as session:
            user = User(id="user_route", display_name="Route User")
            workspace = Workspace(id="ws_route", name="Route Workspace", owner_user_id=user.id)
            project = Project(
                id="proj_route",
                workspace_id=workspace.id,
                name="Route Project",
                idea="Test route",
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

    def test_append_returns_409_on_stale_version(self, client):
        """POST events:append returns 409 when expected_state_version is stale."""
        # Create a run first
        response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_route",
            "workspace_id": "ws_route",
            "project_id": "proj_route",
            "viewer_user_id": "user_route",
            "user_content": "test",
        })
        assert response.status_code == 200
        run_id = response.json()["run_id"]

        # Try to append with stale version
        response = client.post(f"/internal/agent-runs/{run_id}/events:append", json={
            "idempotency_key": "stale_key",
            "expected_state_version": 999,
            "state_patch": {"current_step": 1},
        })
        assert response.status_code == 409

    def test_steering_returns_409_on_stale_version(self, client):
        """POST steering returns 409 when expected_state_version is stale."""
        response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_route2",
            "workspace_id": "ws_route",
            "project_id": "proj_route",
            "viewer_user_id": "user_route",
            "user_content": "test",
        })
        assert response.status_code == 200
        run_id = response.json()["run_id"]

        response = client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "constraint",
            "content": "test",
            "client_message_id": "msg_stale",
            "expected_state_version": 999,
        })
        assert response.status_code == 409

    def test_snapshot_includes_unconsumed_steering(self, client):
        """GET snapshot returns unconsumed_steering array."""
        response = client.post("/internal/agent-runs", json={
            "conversation_id": "conv_route3",
            "workspace_id": "ws_route",
            "project_id": "proj_route",
            "viewer_user_id": "user_route",
            "user_content": "test",
        })
        assert response.status_code == 200
        run_id = response.json()["run_id"]

        # Add steering
        client.post(f"/internal/agent-runs/{run_id}/steering", json={
            "steering_type": "constraint",
            "content": "必须在周五前完成",
            "client_message_id": "msg_snap_route",
        })

        # Get snapshot
        response = client.get(f"/internal/agent-runs/{run_id}/snapshot")
        assert response.status_code == 200
        snapshot = response.json()
        assert "unconsumed_steering" in snapshot
