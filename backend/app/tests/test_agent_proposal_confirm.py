"""Tests for Agent Output Persistence and Confirmation (Issue #17).

Covers the confirm-to-persist path for clarification, stage planning,
and task breakdown outputs. Unconfirmed outputs remain proposals and
do not silently mutate project state.
"""
import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.database import get_session
from app.main import app


@pytest.fixture(name="client")
def client_fixture():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app, headers={"Authorization": "Bearer test-internal-service-token"}) as test_client:
        yield test_client
    app.dependency_overrides.clear()


# ─── Shared helpers ──────────────────────────────────────────────────────────

_IDEMPOTENCY_COUNTER = 0


def _next_idempotency_key(tool_name: str) -> str:
    global _IDEMPOTENCY_COUNTER
    _IDEMPOTENCY_COUNTER += 1
    return f"test-{tool_name}-{_IDEMPOTENCY_COUNTER}-{uuid.uuid4()}"


def _tool_envelope(tool_name: str, workspace_id: str, project_id: str, arguments: dict) -> dict:
    return {
        "run_id": "test-run",
        "conversation_id": "test-conv",
        "workspace_id": workspace_id,
        "project_id": project_id,
        "tool_call_id": f"test-tc-{uuid.uuid4()}",
        "tool_name": tool_name,
        "idempotency_key": _next_idempotency_key(tool_name),
        "arguments": arguments,
    }


_DIRECTION_CARD_OUTPUT = {
    "problem": "大学生项目小队缺乏推进能力",
    "users": "大学生项目团队",
    "value": "AI Agent 主动推进项目",
    "deliverables": ["MVP demo", "README"],
    "boundaries": ["仅限 Web 浏览器"],
    "risks": ["项目超期"],
    "suggested_questions": ["如何确保稳定输出？"],
    "reason": "测试方向卡",
    "requires_confirmation": True,
}

_STAGE_PLAN_OUTPUT = {
    "stages": [
        {
            "name": "核心实现",
            "goal": "完成核心功能",
            "start_date": "2026-07-07",
            "end_date": "2026-07-14",
            "deliverable": "可运行的核心闭环",
            "done_criteria": ["核心流程跑通"],
            "order_index": 0,
            "reason": "优先完成核心",
        }
    ],
    "reason": "测试阶段计划",
    "requires_confirmation": True,
}

_TASK_BREAKDOWN_OUTPUT = {
    "tasks": [
        {
            "id": "t1",
            "stage_id": "placeholder",  # replaced at call time
            "title": "前后端联调",
            "description": "集成前后端",
            "priority": "P1",
            "due_date": "2026-07-10",
            "estimated_hours": 6.0,
            "dependency_ids": [],
            "acceptance_criteria": ["能正常通信"],
            "can_cut": False,
            "order_index": 0,
            "reason": "联调是基础",
        }
    ],
    "reason": "测试任务拆解",
    "requires_confirmation": True,
}


def _call_direction_card_proposal(client: TestClient, workspace_id: str, project_id: str) -> dict:
    """Call direction-card-proposal tool and return response json."""
    envelope = _tool_envelope(
        "direction-card-proposal", workspace_id, project_id,
        {"output": _DIRECTION_CARD_OUTPUT},
    )
    resp = client.post("/internal/agent-tools/direction-card-proposal", json=envelope)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _call_stage_plan_proposal(client: TestClient, workspace_id: str, project_id: str) -> dict:
    """Call stage-plan-proposal tool and return response json."""
    envelope = _tool_envelope(
        "stage-plan-proposal", workspace_id, project_id,
        {"output": _STAGE_PLAN_OUTPUT},
    )
    resp = client.post("/internal/agent-tools/stage-plan-proposal", json=envelope)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _call_task_breakdown_proposal(client: TestClient, workspace_id: str, project_id: str, stage_id: str) -> dict:
    """Call task-breakdown-proposal tool and return response json."""
    output = {**_TASK_BREAKDOWN_OUTPUT, "tasks": [{**_TASK_BREAKDOWN_OUTPUT["tasks"][0], "stage_id": stage_id}]}
    envelope = _tool_envelope(
        "task-breakdown-proposal", workspace_id, project_id,
        {"output": output},
    )
    resp = client.post("/internal/agent-tools/task-breakdown-proposal", json=envelope)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create_full_fixture(client: TestClient):
    """Create a workspace with project, stage, and task for testing."""
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Member"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Proposal Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": member["id"], "role": "member"},
    )
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Proposal Project",
            "idea": "Test confirm-to-persist",
            "deadline": "2026-07-15",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Stage 1",
            "goal": "Plan and build",
            "start_date": "2026-05-29",
            "end_date": "2026-06-02",
            "deliverable": "Working feature",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Task 1",
            "description": "Build feature",
            "priority": "P0",
            "due_date": "2026-05-31",
            "estimated_hours": 3,
        },
    ).json()
    return workspace, project, stage, task, owner, member


def _create_project_without_stage(client: TestClient):
    """Create a workspace and project without stages for activation tests."""
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "No Stage Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "No Stage Project",
            "idea": "Plan from scratch",
            "deadline": "2026-07-15",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    return workspace, project, owner


# --- Clarification (Direction Card) ---


def test_clarify_creates_pending_proposal_not_direction_card(client: TestClient):
    """Clarification output creates a pending proposal, does NOT set direction_card."""
    workspace, project, *_ = _create_full_fixture(client)

    # Project should have no direction_card initially
    project_before = client.get(f"/api/projects/{project['id']}").json()
    assert project_before["direction_card"] is None

    # Run clarification via internal tool
    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    assert data["links"]["proposal_id"] is not None
    assert data["data"]["requires_confirmation"] is True

    # Direction card should STILL be None (unconfirmed)
    project_after = client.get(f"/api/projects/{project['id']}").json()
    assert project_after["direction_card"] is None

    # Proposal should exist and be pending
    proposals = client.get(
        "/api/agent-proposals",
        params={"project_id": project["id"], "proposal_type": "clarify"},
    ).json()
    assert len(proposals) == 1
    assert proposals[0]["status"] == "pending"
    assert proposals[0]["proposal_type"] == "clarify"


def test_confirm_clarification_updates_direction_card(client: TestClient):
    """Confirming clarification proposal updates Project.direction_card."""
    workspace, project, _, _, owner, _ = _create_full_fixture(client)

    # Run clarification
    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    # Confirm the proposal
    confirm_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm_resp.status_code == 200
    assert confirm_resp.json()["status"] == "confirmed"
    assert confirm_resp.json()["confirmed_by"] == owner["id"]

    # Now direction_card should be set
    project_after = client.get(f"/api/projects/{project['id']}").json()
    assert project_after["direction_card"] is not None
    assert "problem" in project_after["direction_card"]
    assert "deliverables" in project_after["direction_card"]


# --- Stage Planning ---


def test_plan_creates_pending_proposal_not_stages(client: TestClient):
    """Stage planning output creates a pending proposal, does NOT create stages."""
    workspace, project, stage, *_ = _create_full_fixture(client)

    # Count stages before
    stages_before = client.get(f"/api/projects/{project['id']}/stages").json()
    count_before = len(stages_before)

    # Run planning via internal tool
    data = _call_stage_plan_proposal(client, workspace["id"], project["id"])
    assert data["links"]["proposal_id"] is not None
    assert data["data"]["requires_confirmation"] is True

    # Stage count should be UNCHANGED (unconfirmed)
    stages_after = client.get(f"/api/projects/{project['id']}/stages").json()
    assert len(stages_after) == count_before

    # Proposal should exist and be pending
    proposals = client.get(
        "/api/agent-proposals",
        params={"project_id": project["id"], "proposal_type": "plan"},
    ).json()
    assert len(proposals) == 1
    assert proposals[0]["status"] == "pending"


def test_confirm_plan_creates_stages(client: TestClient):
    """Confirming planning proposal creates Stage records."""
    workspace, project, stage, _, owner, _ = _create_full_fixture(client)

    stages_before = client.get(f"/api/projects/{project['id']}/stages").json()
    count_before = len(stages_before)

    # Run planning
    data = _call_stage_plan_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    # Confirm the proposal
    confirm_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm_resp.status_code == 200
    assert confirm_resp.json()["status"] == "confirmed"

    # New stages should have been created
    stages_after = client.get(f"/api/projects/{project['id']}/stages").json()
    assert len(stages_after) > count_before


def test_confirm_plan_sets_first_new_stage_active(client: TestClient):
    workspace, project, owner = _create_project_without_stage(client)
    data = _call_stage_plan_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    confirm_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )

    assert confirm_resp.status_code == 200
    stages = client.get(f"/api/projects/{project['id']}/stages").json()
    project_after = client.get(f"/api/projects/{project['id']}").json()
    active_stages = [stage for stage in stages if stage["status"] == "active"]
    assert len(active_stages) == 1
    assert project_after["current_stage_id"] == active_stages[0]["id"]
    assert project_after["status"] == "active"


def test_confirm_plan_does_not_duplicate_active_stage(client: TestClient):
    """Confirming a second plan replaces old stages (completed) and activates the first new stage.

    A confirmed plan is authoritative — the old plan is superseded, its stages become
    "completed", and the new plan's first stage becomes active.
    """
    workspace, project, owner = _create_project_without_stage(client)

    # First plan confirmation -> activates the first stage
    data1 = _call_stage_plan_proposal(client, workspace["id"], project["id"])
    client.post(
        f"/api/agent-proposals/{data1['links']['proposal_id']}/confirm",
        json={"confirmed_by": owner["id"]},
    )

    project_mid = client.get(f"/api/projects/{project['id']}").json()
    original_active_id = project_mid["current_stage_id"]
    assert original_active_id is not None

    stages_after_first = client.get(f"/api/projects/{project['id']}/stages").json()
    assert any(s["status"] == "active" for s in stages_after_first)

    # Second plan confirmation — replaces old plan entirely
    data2 = _call_stage_plan_proposal(client, workspace["id"], project["id"])
    confirm2 = client.post(
        f"/api/agent-proposals/{data2['links']['proposal_id']}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm2.status_code == 200

    all_stages = client.get(f"/api/projects/{project['id']}/stages").json()
    old_stage_ids = {st["id"] for st in stages_after_first}
    old_stages = [s for s in all_stages if s["id"] in old_stage_ids]
    new_stages = [s for s in all_stages if s["id"] not in old_stage_ids]

    # Old stages are now completed
    assert all(s["status"] == "completed" for s in old_stages)
    # New stages exist and the first one is active
    assert len(new_stages) > 0
    assert new_stages[0]["status"] == "active"

    # New active stage is now the current stage
    project_after = client.get(f"/api/projects/{project['id']}").json()
    assert project_after["current_stage_id"] != original_active_id
    assert project_after["current_stage_id"] == new_stages[0]["id"]


# --- Task Breakdown ---


def test_breakdown_creates_pending_proposal_not_tasks(client: TestClient):
    """Task breakdown output creates a pending proposal, does NOT create tasks."""
    workspace, project, stage, *_ = _create_full_fixture(client)

    # Count tasks before
    tasks_before = client.get(f"/api/projects/{project['id']}/tasks").json()
    count_before = len(tasks_before) if "id" in tasks_before else len(tasks_before)

    # Run breakdown via internal tool
    data = _call_task_breakdown_proposal(client, workspace["id"], project["id"], stage["id"])
    assert data["links"]["proposal_id"] is not None
    assert data["data"]["requires_confirmation"] is True

    # Task count should be UNCHANGED (unconfirmed)
    tasks_after = client.get(f"/api/projects/{project['id']}/tasks").json()
    assert len(tasks_after) == count_before

    # Proposal should exist and be pending
    proposals = client.get(
        "/api/agent-proposals",
        params={"project_id": project["id"], "proposal_type": "breakdown"},
    ).json()
    assert len(proposals) == 1
    assert proposals[0]["status"] == "pending"


def test_confirm_breakdown_creates_tasks(client: TestClient):
    """Confirming breakdown proposal creates Task records."""
    workspace, project, stage, _, owner, _ = _create_full_fixture(client)

    tasks_before = client.get(f"/api/projects/{project['id']}/tasks").json()
    count_before = len(tasks_before) if "id" in tasks_before else len(tasks_before)

    # Run breakdown
    data = _call_task_breakdown_proposal(client, workspace["id"], project["id"], stage["id"])
    proposal_id = data["links"]["proposal_id"]

    # Confirm the proposal
    confirm_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm_resp.status_code == 200
    assert confirm_resp.json()["status"] == "confirmed"

    # New tasks should have been created
    tasks_after = client.get(f"/api/projects/{project['id']}/tasks").json()
    assert len(tasks_after) > count_before


# --- Rejection and Invalid Cases ---


def test_reject_proposal_marks_rejected_no_state_mutation(client: TestClient):
    """Rejecting a proposal marks it rejected, no state mutation occurs."""
    workspace, project, *_ = _create_full_fixture(client)

    # Run clarification
    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    # Reject the proposal
    reject_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json={"reason": "Not ready"},
    )
    assert reject_resp.status_code == 200
    assert reject_resp.json()["status"] == "rejected"

    # Direction card should still be None
    project_after = client.get(f"/api/projects/{project['id']}").json()
    assert project_after["direction_card"] is None


def test_reject_proposal_accepts_empty_body(client: TestClient):
    workspace, project, *_ = _create_full_fixture(client)
    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    reject_resp = client.post(f"/api/agent-proposals/{proposal_id}/reject")

    assert reject_resp.status_code == 200
    assert reject_resp.json()["status"] == "rejected"
    project_after = client.get(f"/api/projects/{project['id']}").json()
    assert project_after["direction_card"] is None


def test_cannot_confirm_already_confirmed(client: TestClient):
    """Cannot confirm an already-confirmed proposal."""
    workspace, project, _, _, owner, _ = _create_full_fixture(client)

    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    # First confirm succeeds
    confirm1 = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm1.status_code == 200

    # Second confirm fails
    confirm2 = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm2.status_code == 400


def test_cannot_confirm_rejected_proposal(client: TestClient):
    """Cannot confirm a rejected proposal."""
    workspace, project, _, _, owner, _ = _create_full_fixture(client)

    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    # Reject first
    reject_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json={"reason": "No"},
    )
    assert reject_resp.status_code == 200

    # Now confirm should fail
    confirm_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm_resp.status_code == 400


def test_cannot_reject_already_confirmed(client: TestClient):
    """Cannot reject an already-confirmed proposal."""
    workspace, project, _, _, owner, _ = _create_full_fixture(client)

    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    # Confirm first
    confirm_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm_resp.status_code == 200

    # Now reject should fail
    reject_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json={"reason": "Too late"},
    )
    assert reject_resp.status_code == 400


def test_cannot_reject_already_rejected(client: TestClient):
    """Cannot reject an already-rejected proposal."""
    workspace, project, *_ = _create_full_fixture(client)

    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    # Reject first
    reject1 = client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json={"reason": "No"},
    )
    assert reject1.status_code == 200

    # Reject again should fail
    reject2 = client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json={"reason": "Still no"},
    )
    assert reject2.status_code == 400


# --- Proposal retrieval ---


def test_get_proposal_by_id(client: TestClient):
    """Can retrieve a single proposal by ID."""
    workspace, project, *_ = _create_full_fixture(client)

    data = _call_direction_card_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]

    # Get by ID
    proposal = client.get(f"/api/agent-proposals/{proposal_id}").json()
    assert proposal["id"] == proposal_id
    assert proposal["proposal_type"] == "clarify"
    assert proposal["status"] == "pending"


def test_get_proposal_not_found(client: TestClient):
    """404 for non-existent proposal."""
    response = client.get("/api/agent-proposals/nonexistent-id")
    assert response.status_code == 404


# --- requires_confirmation validators ---


def test_direction_card_requires_confirmation():
    """DirectionCardOutput must have requires_confirmation=True."""
    from app.agent.output_schemas import DirectionCardOutput
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        DirectionCardOutput(
            reason="test",
            problem="p",
            users="u",
            value="v",
            deliverables=["d"],
            requires_confirmation=False,
        )


def test_stage_plan_requires_confirmation():
    """StagePlanOutput must have requires_confirmation=True."""
    from app.agent.output_schemas import StagePlanOutput
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        StagePlanOutput(
            reason="test",
            stages=[],
            requires_confirmation=False,
        )


def test_task_breakdown_requires_confirmation():
    """TaskBreakdownOutput must have requires_confirmation=True."""
    from app.agent.output_schemas import TaskBreakdownOutput
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        TaskBreakdownOutput(
            reason="test",
            tasks=[],
            requires_confirmation=False,
        )
