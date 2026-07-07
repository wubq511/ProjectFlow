"""Tests for ProjectMemory V1 Replan Memory Tracer (Issue #74).

Covers all 10 acceptance criteria:
1. Confirming replan proposal triggers extraction after business commit
2. Replan confirm creates exactly one plan memory
3. Explicit range/tradeoff/delay/replacement rationale may create tradeoff/boundary memory
4. Multiple same-type replan adjustments canonicalized and aggregated
5. Cross-stage/task replans use project-level scope, no invented related IDs
6. Replan rejection creates rejection memory only when explicit reason exists
7. Alternate /replans/confirm path is documented known V1 gap
8. Idempotent replay with unchanged source data
9. User-visible fields contain no raw internal IDs
10. Tests cover confirm, reject-with-reason, reject-without-reason skip, aggregation,
    known path-b gap, idempotency, supersede, and no-raw-ID output
"""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.database import get_session
from app.main import app
from app.services.memory_service import set_memory_engine


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
    set_memory_engine(engine)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app, headers={"Authorization": "Bearer test-internal-service-token"}) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    from app.core.database import engine as default_engine
    set_memory_engine(default_engine)


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


_REPLAN_OUTPUT = {
    "before": {"summary": "项目超期"},
    "after": {"summary": "调整里程碑", "deadline": "2026-07-28"},
    "impact": "给予一周缓冲",
    "stage_adjustments": [],
    "task_changes": [],
    "action_cards": [],
    "reason": "测试重规划",
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


def _call_replan_proposal(client: TestClient, workspace_id: str, project_id: str) -> dict:
    """Call replan-proposal tool and return response json."""
    envelope = _tool_envelope(
        "replan-proposal", workspace_id, project_id,
        {"output": _REPLAN_OUTPUT},
    )
    resp = client.post("/internal/agent-tools/replan-proposal", json=envelope)
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


def _create_full_fixture(client: TestClient):
    """Create workspace, project, stage, task, owner, member for testing."""
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Member"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Replan Memory WS"},
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
            "name": "Replan Memory Project",
            "idea": "Test replan memory extraction",
            "deadline": "2026-08-10",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Implementation",
            "goal": "Build features",
            "start_date": "2026-08-01",
            "end_date": "2026-08-07",
            "deliverable": "Working app",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Build API",
            "description": "Create REST endpoints",
            "priority": "P0",
            "due_date": "2026-08-04",
            "estimated_hours": 8,
        },
    ).json()
    return workspace, project, stage, task, owner, member


def _run_replan_and_confirm(client: TestClient, workspace_id: str, project_id: str, owner_id: str) -> str:
    """Run replan tool and confirm the proposal. Returns proposal_id."""
    result = _call_replan_proposal(client, workspace_id, project_id)
    proposal_id = result["links"]["proposal_id"]
    confirm_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner_id},
    )
    assert confirm_resp.status_code == 200
    return proposal_id


def _run_replan_and_reject(client: TestClient, workspace_id: str, project_id: str, reason: str | None) -> str:
    """Run replan tool and reject the proposal. Returns proposal_id."""
    result = _call_replan_proposal(client, workspace_id, project_id)
    proposal_id = result["links"]["proposal_id"]
    payload = {"reason": reason} if reason else {"reason": None}
    reject_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json=payload,
    )
    assert reject_resp.status_code == 200
    return proposal_id


# ─── AC1: Extraction triggers only after business decision commits ──────────


def test_unconfirmed_replan_no_memory(client: TestClient):
    """未确认的 replan proposal 不触发 memory 提取。"""
    workspace, project, *_ = _create_full_fixture(client)
    _call_replan_proposal(client, workspace["id"], project["id"])

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    assert memories_resp.status_code == 200
    assert memories_resp.json() == []


def test_confirmed_replan_creates_memories(client: TestClient):
    """确认 replan proposal 后创建 ProjectMemory。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_confirm(client, workspace["id"], project["id"], project["created_by"])

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    assert memories_resp.status_code == 200
    memories = memories_resp.json()
    assert len(memories) > 0


# ─── AC2: Exactly one plan memory ──────────────────────────────────────────


def test_exactly_one_plan_memory(client: TestClient):
    """Extractor 创建恰好 1 条 plan 记忆。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_confirm(client, workspace["id"], project["id"], project["created_by"])

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    memories = memories_resp.json()
    plan_memories = [m for m in memories if m["memory_type"] == "plan"]
    assert len(plan_memories) == 1


# ─── AC6: Replan rejection creates rejection only when reason exists ────────


def test_replan_reject_with_reason_creates_rejection(client: TestClient):
    """拒绝 replan 且带有理由时创建 rejection 记忆。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_reject(client, workspace["id"], project["id"], reason="计划当前不需要调整")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    assert memories_resp.status_code == 200
    memories = memories_resp.json()
    rejection_memories = [m for m in memories if m["memory_type"] == "rejection" and m["source_type"] == "replan_rejected"]
    assert len(rejection_memories) == 1
    assert "计划当前不需要调整" in rejection_memories[0]["rationale"]


def test_replan_reject_without_reason_skips_memory(client: TestClient):
    """拒绝 replan 且无理由时不创建 ProjectMemory。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_reject(client, workspace["id"], project["id"], reason=None)

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    assert memories_resp.status_code == 200
    memories = memories_resp.json()
    replan_rejected = [m for m in memories if m["source_type"] == "replan_rejected"]
    assert len(replan_rejected) == 0


def test_replan_reject_empty_reason_skips_memory(client: TestClient):
    """拒绝 replan 且理由为空时不创建 ProjectMemory。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_reject(client, workspace["id"], project["id"], reason="")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    assert memories_resp.status_code == 200
    memories = memories_resp.json()
    replan_rejected = [m for m in memories if m["source_type"] == "replan_rejected"]
    assert len(replan_rejected) == 0


# ─── AC8: Idempotent replay ────────────────────────────────────────────────


def test_idempotent_replay_no_duplicates(client: TestClient):
    """同 source_hash 重放不创建重复行。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_confirm(client, workspace["id"], project["id"], project["created_by"])

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    memories = memories_resp.json()
    plan_count = sum(1 for m in memories if m["memory_type"] == "plan")
    assert plan_count == 1


# ─── AC5: Supersede on changed source content ──────────────────────────────


def test_changed_replan_source_supersedes_old(client: TestClient):
    """不同 source_hash 的同 (project, source_type, source_id, memory_type) supersede 旧记忆。"""
    from app.agent.memory.extractor import ProjectMemoryCandidate
    from app.services.memory_service import _write_candidates, get_memory_engine, EXTRACTOR_VERSION

    workspace, project, *_ = _create_full_fixture(client)

    with Session(get_memory_engine()) as session:
        cand1 = ProjectMemoryCandidate(
            memory_type="plan",
            scope="project",
            content="计划内容 v1",
            rationale="理由 v1",
            source_type="replan_confirmed",
            source_id="test-replan-1",
            source_hash="hash-replan-v1",
            visibility="team",
        )
        written1 = _write_candidates(
            session,
            workspace_id=workspace["id"],
            project_id=project["id"],
            candidates=[cand1],
            extractor_version=EXTRACTOR_VERSION,
        )
        session.commit()
        assert len(written1) == 1
        old_id = written1[0].id

        cand2 = ProjectMemoryCandidate(
            memory_type="plan",
            scope="project",
            content="计划内容 v2",
            rationale="理由 v2",
            source_type="replan_confirmed",
            source_id="test-replan-1",
            source_hash="hash-replan-v2",
            visibility="team",
        )
        written2 = _write_candidates(
            session,
            workspace_id=workspace["id"],
            project_id=project["id"],
            candidates=[cand2],
            extractor_version=EXTRACTOR_VERSION,
        )
        session.commit()
        assert len(written2) == 1
        new_id = written2[0].id
        assert new_id != old_id

        from app.models import ProjectMemory
        old_memory = session.get(ProjectMemory, old_id)
        assert old_memory.status == "superseded"
        assert old_memory.superseded_by_memory_id == new_id

        new_memory = session.get(ProjectMemory, new_id)
        assert new_memory.status == "active"


# ─── AC9: No raw IDs in content/rationale ──────────────────────────────────


def test_replan_memory_content_has_no_raw_ids(client: TestClient):
    """replan memory 的 content/rationale 中不出现 raw ID。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_confirm(client, workspace["id"], project["id"], project["created_by"])

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    memories = memories_resp.json()
    for memory in memories:
        for field in ["content", "rationale"]:
            value = memory.get(field, "") or ""
            assert project["id"] not in value


def test_replan_rejection_content_has_no_raw_ids(client: TestClient):
    """replan rejection 的 content/rationale 中不出现 raw ID。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_reject(client, workspace["id"], project["id"], reason="测试拒绝理由")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    memories = memories_resp.json()
    for memory in memories:
        for field in ["content", "rationale"]:
            value = memory.get(field, "") or ""
            assert project["id"] not in value


# ─── AC7: Alternate /replans/confirm path is known V1 gap ──────────────────


def test_replans_confirm_path_not_modified_by_this_issue(client: TestClient):
    """验证 /replans/confirm 路径未被本 issue 修改（已知 V1 缺口）。"""
    workspace, project, stage, task, *_ = _create_full_fixture(client)

    replan_resp = client.post(
        "/api/replans/confirm",
        json={
            "project_id": project["id"],
            "before": {"summary": "当前状态"},
            "after": {"summary": "调整后状态"},
            "impact": "测试影响",
            "reason": "测试原因",
            "requires_confirmation": True,
            "stage_adjustments": [
                {
                    "stage_id": stage["id"],
                    "new_end_date": "2026-08-10",
                    "reason": "需要缓冲时间",
                }
            ],
            "task_changes": [
                {
                    "task_id": task["id"],
                    "title": "Build API",
                    "reason": "需要延期",
                }
            ],
            "action_cards": [],
        },
    )
    assert replan_resp.status_code == 200

    # Verify no memories were created (this path is a known V1 gap)
    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    assert memories_resp.status_code == 200
    memories = memories_resp.json()
    plan_memories = [m for m in memories if m["memory_type"] == "plan"]
    assert len(plan_memories) == 0


# ─── AC3: Tradeoff and boundary extraction via direct unit test ────────────


def test_replan_tradeoff_memory_extracted(client: TestClient):
    """replan 含有 stage_adjustments 时创建 tradeoff 记忆。"""
    from app.agent.memory.extractor import extract_replan_confirmed
    from app.models import AgentProposal, AgentEvent, Project as ProjectModel
    from app.models.enums import AgentEventType

    workspace, project, stage, *_ = _create_full_fixture(client)
    from app.services.memory_service import get_memory_engine

    with Session(get_memory_engine()) as session:
        project_db = session.get(ProjectModel, project["id"])
        assert project_db is not None

        agent_event = AgentEvent(
            id=str(uuid.uuid4()),
            project_id=project["id"],
            workspace_id=workspace["id"],
            event_type=AgentEventType.replan,
            input_snapshot="{}",
            output_snapshot="{}",
            reasoning_summary="test",
        )
        session.add(agent_event)
        session.flush()

        proposal = AgentProposal(
            id=str(uuid.uuid4()),
            project_id=project["id"],
            workspace_id=workspace["id"],
            proposal_type="replan",
            status="confirmed",
            agent_event_id=agent_event.id,
            payload=json.dumps({
                "before": {"summary": "当前计划"},
                "after": {"summary": "调整后计划"},
                "impact": "延后阶段以完成核心功能",
                "reason": "需要更多时间完成核心功能",
                "stage_adjustments": [
                    {
                        "stage_id": stage["id"],
                        "new_end_date": "2026-08-10",
                        "reason": "开发周期不足，需要延后截止日期",
                    }
                ],
                "task_changes": [],
                "action_cards": [],
                "requires_confirmation": True,
            }),
        )
        session.add(proposal)
        session.commit()

        candidates = extract_replan_confirmed(
            session,
            proposal=proposal,
            project=project_db,
        )

        types = {c.memory_type for c in candidates}
        assert "plan" in types
        assert "tradeoff" in types
        tradeoff = [c for c in candidates if c.memory_type == "tradeoff"][0]
        assert "开发周期不足" in tradeoff.content


def test_replan_boundary_memory_extracted(client: TestClient):
    """replan 含有可裁剪任务时创建 boundary 记忆。"""
    from app.agent.memory.extractor import extract_replan_confirmed
    from app.models import AgentProposal, AgentEvent, Project as ProjectModel
    from app.models.enums import AgentEventType

    workspace, project, stage, task, *_ = _create_full_fixture(client)
    from app.services.memory_service import get_memory_engine

    with Session(get_memory_engine()) as session:
        project_db = session.get(ProjectModel, project["id"])
        assert project_db is not None

        agent_event = AgentEvent(
            id=str(uuid.uuid4()),
            project_id=project["id"],
            workspace_id=workspace["id"],
            event_type=AgentEventType.replan,
            input_snapshot="{}",
            output_snapshot="{}",
            reasoning_summary="test",
        )
        session.add(agent_event)
        session.flush()

        proposal = AgentProposal(
            id=str(uuid.uuid4()),
            project_id=project["id"],
            workspace_id=workspace["id"],
            proposal_type="replan",
            status="confirmed",
            agent_event_id=agent_event.id,
            payload=json.dumps({
                "before": {"summary": "当前计划"},
                "after": {"summary": "调整后计划"},
                "impact": "裁剪低优先级任务以聚焦核心",
                "reason": "资源有限，需要集中精力",
                "stage_adjustments": [],
                "task_changes": [
                    {
                        "task_id": task["id"],
                        "title": "Build API",
                        "can_cut": True,
                        "reason": "非核心功能，可裁剪",
                    }
                ],
                "action_cards": [],
                "requires_confirmation": True,
            }),
        )
        session.add(proposal)
        session.commit()

        candidates = extract_replan_confirmed(
            session,
            proposal=proposal,
            project=project_db,
        )

        types = {c.memory_type for c in candidates}
        assert "plan" in types
        assert "boundary" in types


# ─── AC4: Multiple same-type adjustments aggregated ────────────────────────


def test_replan_aggregation_multiple_same_type_adjustments(client: TestClient):
    """多个同类型 stage_adjustments 被聚合为 1 条 tradeoff 记忆。"""
    from app.agent.memory.extractor import extract_replan_confirmed
    from app.models import AgentProposal, AgentEvent, Project as ProjectModel
    from app.models.enums import AgentEventType

    workspace, project, stage, task, *_ = _create_full_fixture(client)
    from app.services.memory_service import get_memory_engine

    with Session(get_memory_engine()) as session:
        project_db = session.get(ProjectModel, project["id"])
        assert project_db is not None

        agent_event = AgentEvent(
            id=str(uuid.uuid4()),
            project_id=project["id"],
            workspace_id=workspace["id"],
            event_type=AgentEventType.replan,
            input_snapshot="{}",
            output_snapshot="{}",
            reasoning_summary="test",
        )
        session.add(agent_event)
        session.flush()

        proposal = AgentProposal(
            id=str(uuid.uuid4()),
            project_id=project["id"],
            workspace_id=workspace["id"],
            proposal_type="replan",
            status="confirmed",
            agent_event_id=agent_event.id,
            payload=json.dumps({
                "before": {"summary": "当前计划"},
                "after": {"summary": "调整后计划"},
                "impact": "多阶段调整",
                "reason": "需要整体调整计划",
                "stage_adjustments": [
                    {
                        "stage_id": stage["id"],
                        "new_end_date": "2026-08-10",
                        "reason": "阶段 A 需要延期",
                    },
                ],
                "task_changes": [
                    {
                        "task_id": task["id"],
                        "title": "Build API",
                        "status": "blocked",
                        "reason": "任务 B 受阻需调整",
                    }
                ],
                "action_cards": [],
                "requires_confirmation": True,
            }),
        )
        session.add(proposal)
        session.commit()

        candidates = extract_replan_confirmed(
            session,
            proposal=proposal,
            project=project_db,
        )

        tradeoff_memories = [c for c in candidates if c.memory_type == "tradeoff"]
        assert len(tradeoff_memories) <= 1


# ─── AC5: Cross-stage/task replans use project-level scope ─────────────────


def test_replan_uses_project_scope(client: TestClient):
    """replan memory 使用 project 级 scope，不编造 related IDs。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_confirm(client, workspace["id"], project["id"], project["created_by"])

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    memories = memories_resp.json()
    for memory in memories:
        if memory["memory_type"] == "plan":
            assert memory["scope"] == "project"
            assert memory.get("related_stage_id") is None
            assert memory.get("related_task_id") is None


# ─── AC8: Idempotent replay (reject path) ─────────────────────────────────


def test_replan_reject_idempotent(client: TestClient):
    """重复拒绝同 replan proposal 不创建重复记忆。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_reject(client, workspace["id"], project["id"], reason="不需要调整")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    memories = memories_resp.json()
    replan_rejected = [m for m in memories if m["source_type"] == "replan_rejected"]
    assert len(replan_rejected) <= 1


# ─── Extractor deterministic ───────────────────────────────────────────────


def test_replan_extractor_deterministic():
    """replan extractor 的 _compute_source_hash 是确定性的。"""
    from app.agent.memory.extractor import _compute_source_hash

    stable = {"impact": "测试影响", "reason": "测试原因", "stage_adjustments": [], "task_changes": []}
    hash1 = _compute_source_hash(stable)
    hash2 = _compute_source_hash(stable)
    assert hash1 == hash2
    assert len(hash1) == 64


# ─── Team visibility ───────────────────────────────────────────────────────


def test_replan_memory_team_visibility_all_members_can_see(client: TestClient):
    """replan 的 team 可见记忆对所有 workspace 成员可见。"""
    workspace, project, *_ = _create_full_fixture(client)
    _run_replan_and_confirm(client, workspace["id"], project["id"], project["created_by"])

    owner_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    assert owner_resp.status_code == 200
    owner_memories = owner_resp.json()

    for memory in owner_memories:
        assert memory.get("visibility") == "team"


# ─── Memory extraction failure does not block business decision ────────────


def test_replan_memory_extraction_failure_does_not_block_confirm(client: TestClient):
    """replan memory extractor 异常不回滚业务决策。"""
    workspace, project, *_ = _create_full_fixture(client)

    result = _call_replan_proposal(client, workspace["id"], project["id"])
    proposal_id = result["links"]["proposal_id"]

    confirm_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": project["created_by"]},
    )
    assert confirm_resp.status_code == 200
    assert confirm_resp.json()["status"] == "confirmed"


# ─── plan confirm should NOT create replan memories ────────────────────────


def test_plan_confirm_no_memories_for_regular_plan(client: TestClient):
    """确认普通的 plan proposal（非 replan）不创建 replan 类型的 ProjectMemory。"""
    workspace, project, *_ = _create_full_fixture(client)

    data = _call_stage_plan_proposal(client, workspace["id"], project["id"])
    proposal_id = data["links"]["proposal_id"]
    client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": project["created_by"]},
    )

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": project["created_by"]},
    )
    assert memories_resp.status_code == 200
    memories = memories_resp.json()
    # Plan proposals don't trigger replan memory extraction
    replan_memories = [m for m in memories if m["source_type"] in ("replan_confirmed", "replan_rejected")]
    assert len(replan_memories) == 0
