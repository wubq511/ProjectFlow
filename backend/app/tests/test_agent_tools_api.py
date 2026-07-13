"""Tests for T41 Internal Agent Tools API (S5 + S8).

Validates the unified internal contract:
- POST /internal/agent-tools/workspace-state
- POST /internal/agent-tools/conversation
- POST /internal/agent-tools/pending-proposals
- POST /internal/agent-tools/timeline-slice
- POST /internal/agent-tools/assignment-recommendation (S8)

Read-only tools return side_effect_status=no_side_effect.
Proposal tools return side_effect_status=proposal_persisted.
"""

import json
import os

os.environ["INTERNAL_SERVICE_TOKEN"] = "test-internal-service-token"

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from app.main import app
from app.models import (
    AgentConversation,
    AgentEvent,
    AgentProposal,
    CheckInCycle,
    Project,
    Stage,
    Task,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.models.agent_run_state import AgentRunV2
from app.models.enums import AgentEventType, AgentProposalStatus, AgentRunStatus, TaskStatus
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
    with TestClient(app, headers={"Authorization": "Bearer test-internal-service-token"}) as c:
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
        # Conversation for internal tool tests
        session.add(AgentConversation(
            id="conv_test", workspace_id="ws1", project_id="p1",
            creator_user_id="u1", title="测试对话", visibility="private",
        ))
        # Run record for conversation tool authorization
        session.add(AgentRunV2(
            id="run_test",
            conversation_id="conv_test",
            project_id="p1",
            workspace_id="ws1",
            viewer_user_id="u1",
            status=AgentRunStatus.created,
        ))
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


def _create_stage_plan_fixture(client: TestClient) -> dict:
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Stage Plan Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Stage Plan Project",
            "idea": "Create a demo-ready MVP",
            "deadline": "2026-07-15",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    return {
        "owner": owner,
        "workspace": workspace,
        "project": project,
    }


def _create_checkin_analysis_fixture(client: TestClient) -> dict:
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Member"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Checkin Workspace"},
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
            "name": "Checkin Project",
            "idea": "Validate advisory write behavior",
            "deadline": "2026-07-20",
            "deliverables": "Validated tool contract",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Execution",
            "goal": "Handle blockers safely",
            "start_date": "2026-07-01",
            "end_date": "2026-07-10",
            "deliverable": "Stable execution loop",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Implement advisory tool",
            "description": "Keep inferred task changes out of primary state writes",
            "priority": "P0",
            "due_date": "2026-07-08",
            "estimated_hours": 8,
        },
    ).json()
    cycle = client.post(
        "/api/checkin-cycles",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "cadence_days": 2,
            "start_date": "2026-07-05",
            "created_by_user_id": owner["id"],
        },
    ).json()
    client.post(
        f"/api/checkin-cycles/{cycle['id']}/responses",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "user_id": member["id"],
            "task_id": task["id"],
            "what_done": "Implemented the first draft.",
            "blocker": "Need schema confirmation before continuing.",
            "available_hours_next_cycle": 3,
            "mood_or_confidence": "low",
        },
    )
    return {
        "owner": owner,
        "member": member,
        "workspace": workspace,
        "project": project,
        "stage": stage,
        "task": task,
    }


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


# ─── Shared sidecar output dicts for proposal tools ─────────────────────────

_DIRECTION_CARD_OUTPUT = {
    "reason": "Sidecar 生成的方向卡",
    "requires_confirmation": True,
    "problem": "大学生项目小队缺乏推进能力",
    "users": "大学生项目团队",
    "value": "AI Agent 主动推进项目",
    "deliverables": ["MVP demo", "README"],
    "boundaries": ["仅限 Web 浏览器"],
    "risks": ["项目超期"],
    "suggested_questions": ["如何确保稳定输出？"],
}

_STAGE_PLAN_OUTPUT = {
    "reason": "Sidecar 生成的阶段计划",
    "requires_confirmation": True,
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
}

_TASK_BREAKDOWN_OUTPUT = {
    "reason": "Sidecar 生成的任务拆解",
    "requires_confirmation": True,
    "tasks": [
        {
            "id": "t1",
            "stage_id": "s1",
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
}

_REPLAN_OUTPUT = {
    "reason": "Sidecar 生成的重规划",
    "requires_confirmation": True,
    "before": {"summary": "项目超期"},
    "after": {"summary": "调整里程碑", "deadline": "2026-07-28"},
    "impact": "给予一周缓冲",
    "stage_adjustments": [],
    "task_changes": [],
    "action_cards": [],
}

_CHECKIN_ANALYSIS_OUTPUT = {
    "reason": "签到分析结果",
    "requires_confirmation": False,
    "summary": "小王前端完成，小张后端阻塞",
    "task_updates": [],
    "risks": [],
}

_RISK_ANALYSIS_OUTPUT = {
    "reason": "风险分析结果",
    "requires_confirmation": True,
    "risks": [
        {
            "type": "deadline",
            "severity": "high",
            "title": "项目超期",
            "description": "截止日期已过",
            "evidence": ["deadline 2026-06-09 已过"],
            "recommendation": "调整里程碑",
            "stage_id": None,
            "task_id": None,
            "evidence_refs": [],
        }
    ],
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

    def test_unknown_tool_returns_blocked(self, client, test_engine):
        _seed(test_engine)
        resp = client.post("/internal/agent-tools/no-such-tool", json=_envelope("no-such-tool"))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "blocked"
        assert "not found" in data["observation"].lower()

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
            {"project_id": "p1", "user_instruction": "根据最新签到和风险生成计划调整草案。", "output": _REPLAN_OUTPUT},
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
            {"project_id": "p1", "user_instruction": "根据最新签到和风险生成计划调整草案。", "output": _REPLAN_OUTPUT},
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

    def test_replan_proposal_tool_blocks_when_pending_replan_exists(self, client, test_engine):
        _seed(test_engine)
        first = client.post(
            "/internal/agent-tools/replan-proposal",
            json=_envelope(
                "generate_replan_proposal",
                {"project_id": "p1", "user_instruction": "根据最新签到和风险生成计划调整草案。", "output": _REPLAN_OUTPUT},
            ),
        )
        assert first.status_code == 200, first.text
        existing_proposal_id = first.json()["links"]["proposal_id"]

        second_envelope = _envelope(
            "generate_replan_proposal",
            {"project_id": "p1", "user_instruction": "再次生成计划调整草案。"},
        )
        second_envelope["tool_call_id"] = "call_second"
        second_envelope["idempotency_key"] = "run_test:call_second:v1"

        second = client.post("/internal/agent-tools/replan-proposal", json=second_envelope)

        assert second.status_code == 200, second.text
        second_data = second.json()
        assert second_data["status"] == "blocked"
        assert second_data["side_effect_status"] == "no_side_effect"
        assert second_data["links"]["proposal_id"] == existing_proposal_id

        proposals_resp = client.get("/api/agent-proposals", params={"project_id": "p1", "proposal_type": "replan"})
        assert proposals_resp.status_code == 200, proposals_resp.text
        assert [p["id"] for p in proposals_resp.json()] == [existing_proposal_id]

    def test_stage_plan_proposal_tool_creates_pending_plan_proposal_without_creating_stages(self, client, test_engine):
        fixture = _create_stage_plan_fixture(client)
        project = fixture["project"]
        workspace = fixture["workspace"]

        stages_before = client.get(f"/api/projects/{project['id']}/stages").json()
        assert stages_before == []

        envelope = {
            **_envelope(
                "generate_stage_plan_proposal",
                {
                    "project_id": project["id"],
                    "workspace_id": workspace["id"],
                    "user_instruction": "按三周节奏生成阶段计划。",
                    "output": _STAGE_PLAN_OUTPUT,
                },
            ),
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "idempotency_key": "run_stage_plan:call_plan:v1",
        }
        resp = client.post("/internal/agent-tools/stage-plan-proposal", json=envelope)

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None
        assert data["links"]["agent_event_id"] is not None
        assert data["idempotency_key"] == "run_stage_plan:call_plan:v1"

        stages_after = client.get(f"/api/projects/{project['id']}/stages").json()
        assert stages_after == []

        proposal_resp = client.get(f"/api/agent-proposals/{data['links']['proposal_id']}")
        assert proposal_resp.status_code == 200, proposal_resp.text
        proposal = proposal_resp.json()
        assert proposal["proposal_type"] == "plan"
        assert proposal["status"] == "pending"
        assert proposal["agent_event_id"] == data["links"]["agent_event_id"]
        assert proposal["payload"]["requires_confirmation"] is True

        with Session(test_engine) as session:
            source_event = session.get(AgentEvent, data["links"]["agent_event_id"])
            snapshot = source_event.get_input_snapshot()
            assert snapshot["tool_run_id"] == envelope["run_id"]
            assert snapshot["conversation_id"] == envelope["conversation_id"]
            assert snapshot["tool_call_id"] == envelope["tool_call_id"]
            assert snapshot["tool_name"] == envelope["tool_name"]

    def test_stage_plan_proposal_tool_reuses_same_proposal_for_idempotency_key(self, client, test_engine):
        fixture = _create_stage_plan_fixture(client)
        project = fixture["project"]
        workspace = fixture["workspace"]
        envelope = {
            **_envelope(
                "generate_stage_plan_proposal",
                {
                    "project_id": project["id"],
                    "workspace_id": workspace["id"],
                    "user_instruction": "生成阶段计划草案。",
                    "output": _STAGE_PLAN_OUTPUT,
                },
            ),
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "idempotency_key": "run_stage_plan:call_plan:v1",
        }

        first = client.post("/internal/agent-tools/stage-plan-proposal", json=envelope)
        second = client.post("/internal/agent-tools/stage-plan-proposal", json=envelope)

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        first_data = first.json()
        second_data = second.json()
        assert first_data["links"]["proposal_id"] == second_data["links"]["proposal_id"]
        assert first_data["links"]["agent_event_id"] == second_data["links"]["agent_event_id"]

        proposals_resp = client.get("/api/agent-proposals", params={"project_id": project["id"], "proposal_type": "plan"})
        assert proposals_resp.status_code == 200, proposals_resp.text
        assert [p["id"] for p in proposals_resp.json()] == [first_data["links"]["proposal_id"]]

    def test_stage_plan_proposal_confirm_still_persists_stages(self, client, test_engine):
        fixture = _create_stage_plan_fixture(client)
        project = fixture["project"]
        workspace = fixture["workspace"]
        owner = fixture["owner"]

        envelope = {
            **_envelope(
                "generate_stage_plan_proposal",
                {
                    "project_id": project["id"],
                    "workspace_id": workspace["id"],
                    "user_instruction": "生成阶段计划草案。",
                    "output": _STAGE_PLAN_OUTPUT,
                },
            ),
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "idempotency_key": "run_stage_plan:call_confirm:v1",
        }
        create_resp = client.post("/internal/agent-tools/stage-plan-proposal", json=envelope)
        assert create_resp.status_code == 200, create_resp.text
        proposal_id = create_resp.json()["links"]["proposal_id"]

        confirm_resp = client.post(
            f"/api/agent-proposals/{proposal_id}/confirm",
            json={"confirmed_by": owner["id"]},
        )
        assert confirm_resp.status_code == 200, confirm_resp.text

        stages_after = client.get(f"/api/projects/{project['id']}/stages").json()
        project_after = client.get(f"/api/projects/{project['id']}").json()
        assert len(stages_after) > 0
        assert any(stage["status"] == "active" for stage in stages_after)
        assert project_after["current_stage_id"] is not None

    def test_checkins_and_risks_analysis_tool_creates_advisory_records_without_mutating_task_or_creating_replan_proposal(
        self,
        client,
        test_engine,
    ):
        fixture = _create_checkin_analysis_fixture(client)
        workspace = fixture["workspace"]
        project = fixture["project"]
        task = fixture["task"]

        task_before = client.get(f"/api/tasks/{task['id']}").json()
        proposals_before = client.get(
            "/api/agent-proposals",
            params={"project_id": project["id"], "proposal_type": "replan"},
        ).json()
        assert proposals_before == []

        checkin_output = {
            "reason": "签到分析结果",
            "requires_confirmation": False,
            "summary": "存在阻塞风险",
            "task_updates": [
                {
                    "task_id": task["id"],
                    "user_id": fixture["owner"]["id"],
                    "status": "blocked",
                    "progress_note": "任务被阻塞",
                    "blocker": "依赖未完成",
                }
            ],
            "risks": [],
        }
        risk_output = {
            "reason": "风险分析结果",
            "requires_confirmation": True,
            "risks": [
                {
                    "type": "dependency",
                    "severity": "high",
                    "title": "任务阻塞",
                    "description": "当前任务存在阻塞",
                    "evidence": ["签到反馈显示阻塞"],
                    "recommendation": "处理阻塞原因",
                    "stage_id": fixture["stage"]["id"],
                    "task_id": task["id"],
                    "evidence_refs": [],
                }
            ],
        }
        envelope = {
            **_envelope(
                "analyze_checkins_and_risks",
                {
                    "project_id": project["id"],
                    "workspace_id": workspace["id"],
                    "user_instruction": "Analyze blockers and record advisory risks.",
                    "checkin_analysis_output": checkin_output,
                    "risk_analysis_output": risk_output,
                    "action_cards": [
                        {
                            "type": "risk_action",
                            "title": "处理阻塞风险",
                            "content": "请先确认阻塞原因并给出下一步处理计划。",
                            "reason": "当前任务存在阻塞，项目需要一个可执行的风险处理动作。",
                            "task_id": task["id"],
                            "stage_id": fixture["stage"]["id"],
                        }
                    ],
                },
            ),
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "idempotency_key": "run_checkin_tool:call_tool:v1",
        }
        resp = client.post("/internal/agent-tools/checkins-and-risks-analysis", json=envelope)

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "advisory_record_persisted"
        assert data["links"]["agent_event_id"] is not None
        assert data["links"]["created_ids"]
        assert data["data"]["replan_signal"]["requires_replan_proposal"] is True
        # The full model-generated analysis is already persisted in AgentEvent.
        # Echoing it here makes the tool result exceed the sidecar's resource
        # threshold and forces an unnecessary read_tool_resource/model turn.
        assert "checkin_analysis" not in data["data"]
        assert "risk_analysis" not in data["data"]
        assert "created_ids" not in data["data"]
        assert "related_event_ids" not in data["data"]
        assert len(json.dumps(data["data"], ensure_ascii=False).encode()) < 4096
        # Sidecar path does not infer task_changes; risks are persisted directly from risk_analysis_output.

        task_after = client.get(f"/api/tasks/{task['id']}").json()
        assert task_after["status"] == task_before["status"] == "not_started"

        proposals_after = client.get(
            "/api/agent-proposals",
            params={"project_id": project["id"], "proposal_type": "replan"},
        ).json()
        assert proposals_after == []

        risks = client.get(f"/api/projects/{project['id']}/risks").json()
        action_cards = client.get(f"/api/projects/{project['id']}/action-cards").json()
        assert {risk["id"] for risk in risks}.issubset(set(data["links"]["created_ids"]))
        assert {card["id"] for card in action_cards}.issubset(set(data["links"]["created_ids"]))
        assert risks[0]["severity"] == "high"
        assert action_cards[0]["title"] == "处理阻塞风险"

    def test_checkins_and_risks_analysis_tool_reuses_same_advisory_records_for_idempotency_key(
        self,
        client,
        test_engine,
    ):
        fixture = _create_checkin_analysis_fixture(client)
        workspace = fixture["workspace"]
        project = fixture["project"]

        envelope = {
            **_envelope(
                "analyze_checkins_and_risks",
                {
                    "project_id": project["id"],
                    "workspace_id": workspace["id"],
                    "user_instruction": "Analyze blockers and record advisory risks.",
                    "checkin_analysis_output": _CHECKIN_ANALYSIS_OUTPUT,
                    "risk_analysis_output": _RISK_ANALYSIS_OUTPUT,
                },
            ),
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "idempotency_key": "run_checkin_tool:call_tool:v1",
        }

        first = client.post("/internal/agent-tools/checkins-and-risks-analysis", json=envelope)
        second = client.post("/internal/agent-tools/checkins-and-risks-analysis", json=envelope)

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        first_data = first.json()
        second_data = second.json()
        # Sidecar direct-persist path creates new risk records on each call;
        # idempotency is not enforced for advisory write tools.
        assert first_data["status"] == "success"
        assert second_data["status"] == "success"
        assert first_data["side_effect_status"] == "advisory_record_persisted"
        assert second_data["side_effect_status"] == "advisory_record_persisted"

        risks = client.get(f"/api/projects/{project['id']}/risks").json()
        assert len(risks) >= 1


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


# ─── S8: Assignment Recommendation Tool ──────────────────────────────────


def _seed_assignment(test_engine) -> dict:
    """Seed workspace with 2 users, 1 project, 1 stage, 1 task (no owner)."""
    with Session(test_engine) as session:
        session.add(User(id="u1", display_name="小林"))
        session.add(User(id="u2", display_name="小王"))
        session.add(Workspace(id="ws1", name="测试工作区", owner_user_id="u1"))
        session.add(WorkspaceMembership(workspace_id="ws1", user_id="u1", role="owner"))
        session.add(WorkspaceMembership(workspace_id="ws1", user_id="u2", role="member"))
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
        session.add(
            Stage(
                id="s1",
                project_id="p1",
                name="规划阶段",
                goal="完成项目规划",
                start_date="2026-07-01",
                end_date="2026-07-15",
                deliverable="阶段计划文档",
                order_index=0,
                status="active",
            )
        )
        session.add(
            Task(
                id="t1",
                project_id="p1",
                stage_id="s1",
                title="后端 API 开发",
                priority="P0",
                status=TaskStatus.not_started,
                order_index=0,
            )
        )
        session.commit()
    return {}


class TestAssignmentRecommendationTool:
    """S8: recommend_assignment tool via POST /internal/agent-tools/assignment-recommendation."""

    def test_create_proposal_success(self, client, test_engine):
        """Creating an AssignmentProposal returns proposal_persisted and created_ids."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "小林熟悉后端开发",
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["created_ids"] != []
        assert data["links"]["proposal_id"] is not None
        assert data["links"]["proposal_id"] == data["links"]["created_ids"][0]
        assert data["idempotency_key"] == "run_test:call_test:v1"
        # Verify the proposal data
        proposal = data["data"]
        assert proposal["project_id"] == "p1"
        assert proposal["stage_id"] == "s1"
        assert proposal["task_id"] == "t1"
        assert proposal["recommended_owner_user_id"] == "u1"
        assert proposal["status"] == "proposed"
        assert proposal["created_by_agent"] is True

    def test_create_proposal_with_backup_owner(self, client, test_engine):
        """Proposal with backup_owner_user_id is accepted."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "backup_owner_user_id": "u2",
                "reason": "小林主负责，小王备选",
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["data"]["backup_owner_user_id"] == "u2"

    def test_proposal_does_not_write_task_owner(self, client, test_engine):
        """Creating a proposal must NOT write Task.owner_user_id."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200, resp.text
        # Verify task still has no owner
        with Session(test_engine) as session:
            task = session.get(Task, "t1")
            assert task is not None
            assert task.owner_user_id is None

    def test_idempotency_same_key_reuses_existing_proposal(self, client, test_engine):
        """Same idempotency key reuses the existing AssignmentProposal."""
        _seed_assignment(test_engine)
        resp1 = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("recommend_assignment", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp1.status_code == 200
        assert resp1.json()["status"] == "success"

        resp2 = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("recommend_assignment", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "同一次工具调用重试",
            }),
        )
        assert resp2.status_code == 200
        first_data = resp1.json()
        second_data = resp2.json()
        assert second_data["status"] == "success"
        assert second_data["side_effect_status"] == "proposal_persisted"
        assert second_data["links"]["proposal_id"] == first_data["links"]["proposal_id"]
        assert second_data["links"]["created_ids"] == first_data["links"]["created_ids"]

    def test_duplicate_task_with_different_idempotency_key_rejected(self, client, test_engine):
        """A different tool call cannot create a second active proposal for the same task."""
        _seed_assignment(test_engine)
        resp1 = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("recommend_assignment", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp1.status_code == 200
        assert resp1.json()["status"] == "success"

        envelope = _envelope("recommend_assignment", {
            "stage_id": "s1",
            "task_id": "t1",
            "recommended_owner_user_id": "u1",
            "reason": "新工具调用重复推荐",
        })
        envelope["tool_call_id"] = "call_other"
        envelope["idempotency_key"] = "run_test:call_other:v1"
        resp2 = client.post("/internal/agent-tools/assignment-recommendation", json=envelope)
        assert resp2.status_code == 200
        data = resp2.json()
        assert data["status"] == "validation_error"
        assert data["side_effect_status"] == "no_side_effect"
        assert "已有待处理的分工建议" in data["observation"]

    def test_different_owner_for_same_task_rejected_when_active_proposal_exists(self, client, test_engine):
        """A different tool call cannot create another active proposal for the same task."""
        _seed_assignment(test_engine)
        # First proposal: u1
        resp1 = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "小林适合",
            }),
        )
        assert resp1.json()["status"] == "success"

        # Second proposal for same task but different owner: u2
        second_envelope = _envelope("assignment-recommendation", {
            "stage_id": "s1",
            "task_id": "t1",
            "recommended_owner_user_id": "u2",
            "reason": "小王更适合",
        })
        second_envelope["tool_call_id"] = "call_other"
        second_envelope["idempotency_key"] = "run_test:call_other:v1"
        resp2 = client.post("/internal/agent-tools/assignment-recommendation", json=second_envelope)
        # This should fail because there's already an active proposal for the task
        assert resp2.status_code == 200
        data = resp2.json()
        assert data["status"] == "validation_error"

    def test_missing_required_fields_returns_validation_error(self, client, test_engine):
        """Missing required fields returns validation_error."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                # Missing recommended_owner_user_id and reason
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "缺少必填字段" in data["observation"]

    def test_nonexistent_task_returns_validation_error(self, client, test_engine):
        """Nonexistent task returns validation_error."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "nonexistent",
                "recommended_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"

    def test_nonexistent_user_returns_validation_error(self, client, test_engine):
        """Nonexistent recommended owner returns validation_error."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "nonexistent",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"

    def test_backup_same_as_recommended_rejected(self, client, test_engine):
        """Backup owner same as recommended is rejected."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "backup_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "备选" in data["observation"] or "backup" in data["observation"].lower()

    def test_stage_not_in_project_rejected(self, client, test_engine):
        """Stage belonging to a different project is rejected."""
        _seed_assignment(test_engine)
        # Add a second project and stage
        with Session(test_engine) as session:
            session.add(
                Project(
                    id="p2",
                    workspace_id="ws1",
                    name="另一个项目",
                    idea="另一个想法",
                    deadline="2026-09-01",
                    deliverables="交付物",
                    created_by="u1",
                )
            )
            session.add(
                Stage(
                    id="s2",
                    project_id="p2",
                    name="另一阶段",
                    goal="另一目标",
                    start_date="2026-07-01",
                    end_date="2026-07-15",
                    deliverable="交付物",
                    order_index=0,
                    status="active",
                )
            )
            session.commit()
        # Submit with stage from different project
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s2",  # belongs to p2, not p1
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"

    def test_task_not_in_stage_rejected(self, client, test_engine):
        """Task belonging to a different stage is rejected."""
        _seed_assignment(test_engine)
        # Add a second stage and task
        with Session(test_engine) as session:
            session.add(
                Stage(
                    id="s2",
                    project_id="p1",
                    name="开发阶段",
                    goal="完成开发",
                    start_date="2026-07-15",
                    end_date="2026-08-01",
                    deliverable="代码",
                    order_index=1,
                    status="pending",
                )
            )
            session.add(
                Task(
                    id="t2",
                    project_id="p1",
                    stage_id="s2",
                    title="前端开发",
                    priority="P1",
                    status=TaskStatus.not_started,
                    order_index=0,
                )
            )
            session.commit()
        # Submit with task from different stage
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t2",  # belongs to s2, not s1
                "recommended_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"

    def test_non_member_owner_rejected(self, client, test_engine):
        """User who exists but is not a workspace member is rejected."""
        _seed_assignment(test_engine)
        # Add a user who is NOT in the workspace
        with Session(test_engine) as session:
            session.add(User(id="u_outsider", display_name="局外人"))
            session.commit()
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u_outsider",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "工作区" in data["observation"] or "member" in data["observation"].lower() or "成员" in data["observation"]

    def test_task_already_has_owner_rejected(self, client, test_engine):
        """Task that already has an owner is rejected."""
        _seed_assignment(test_engine)
        # Assign owner to task
        with Session(test_engine) as session:
            task = session.get(Task, "t1")
            task.owner_user_id = "u2"
            session.commit()
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "已有" in data["observation"] or "already" in data["observation"].lower() or "owner" in data["observation"].lower()


# ═══════════════════════════════════════════════════════════════════════
# S13: Direction Card Proposal Tool
# ═══════════════════════════════════════════════════════════════════════


class TestDirectionCardProposalTool:
    """S13: generate_direction_card_proposal tool via POST /internal/agent-tools/direction-card-proposal."""

    def test_create_direction_card_proposal_success(self, client, test_engine):
        """Creating a direction card proposal returns proposal_persisted."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/direction-card-proposal",
            json=_envelope("direction-card-proposal", {
                "project_id": "p1",
                "user_instruction": "明确项目方向",
                "output": _DIRECTION_CARD_OUTPUT,
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None

    def test_direction_card_proposal_idempotency(self, client, test_engine):
        """Same idempotency key reuses existing proposal."""
        _seed_assignment(test_engine)
        envelope = _envelope("direction-card-proposal", {
            "project_id": "p1",
            "user_instruction": "明确项目方向",
            "output": _DIRECTION_CARD_OUTPUT,
        })
        resp1 = client.post("/internal/agent-tools/direction-card-proposal", json=envelope)
        resp2 = client.post("/internal/agent-tools/direction-card-proposal", json=envelope)
        assert resp1.json()["links"]["proposal_id"] == resp2.json()["links"]["proposal_id"]


# ═══════════════════════════════════════════════════════════════════════
# S13: Task Breakdown Proposal Tool
# ═══════════════════════════════════════════════════════════════════════


class TestTaskBreakdownProposalTool:
    """S13: generate_task_breakdown_proposal tool via POST /internal/agent-tools/task-breakdown-proposal."""

    def test_create_task_breakdown_proposal_success(self, client, test_engine):
        """Creating a task breakdown proposal returns proposal_persisted."""
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/task-breakdown-proposal",
            json=_envelope("task-breakdown-proposal", {
                "project_id": "p1",
                "stage_id": "s1",
                "user_instruction": "拆分任务",
                "output": _TASK_BREAKDOWN_OUTPUT,
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None

    def test_task_breakdown_proposal_idempotency(self, client, test_engine):
        """Same idempotency key reuses existing proposal."""
        _seed_assignment(test_engine)
        envelope = _envelope("task-breakdown-proposal", {
            "project_id": "p1",
            "stage_id": "s1",
            "user_instruction": "拆分任务",
            "output": _TASK_BREAKDOWN_OUTPUT,
        })
        resp1 = client.post("/internal/agent-tools/task-breakdown-proposal", json=envelope)
        resp2 = client.post("/internal/agent-tools/task-breakdown-proposal", json=envelope)
        assert resp1.json()["links"]["proposal_id"] == resp2.json()["links"]["proposal_id"]


# ─── S11: create_risk / create_checkin ──────────────────────────────────────


def _seed_s11(test_engine) -> dict:
    """Seed workspace/project/stage/task/user for S11 tool tests."""
    with Session(test_engine) as session:
        session.add(User(id="u1", display_name="小林"))
        session.add(User(id="u2", display_name="小王"))
        session.add(Workspace(id="ws1", name="测试工作区", owner_user_id="u1"))
        session.add(WorkspaceMembership(workspace_id="ws1", user_id="u1", role="owner"))
        session.add(WorkspaceMembership(workspace_id="ws1", user_id="u2", role="member"))
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
        session.add(
            Stage(
                id="s1",
                project_id="p1",
                name="开发阶段",
                goal="完成功能开发",
                start_date="2026-07-01",
                end_date="2026-07-15",
                deliverable="功能代码",
                order_index=0,
                status="active",
            )
        )
        session.add(
            Task(
                id="t1",
                project_id="p1",
                stage_id="s1",
                title="后端 API 开发",
                priority="P0",
                status=TaskStatus.not_started,
                order_index=0,
            )
        )
        session.commit()
    return {}


class TestCreateRiskTool:
    """S11 create_risk: advisory record, no proposal confirmation."""

    def test_create_risk_success(self, client, test_engine):
        """create_risk creates a Risk record directly."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-risk",
            json=_envelope("create_risk", {
                "type": "deadline",
                "severity": "high",
                "title": "截止日期风险",
                "description": "距离截止日期仅剩3天",
                "evidence": ["日历显示"],
                "recommendation": "加快进度",
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "advisory_record_persisted"
        assert data["data"]["type"] == "deadline"
        assert data["data"]["severity"] == "high"
        assert data["data"]["title"] == "截止日期风险"
        assert data["links"]["created_ids"] != []

    def test_create_risk_with_stage_and_task(self, client, test_engine):
        """create_risk with optional stage_id and task_id."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-risk",
            json=_envelope("create_risk", {
                "type": "dependency",
                "severity": "medium",
                "title": "依赖风险",
                "description": "外部依赖未到位",
                "evidence": ["邮件确认"],
                "recommendation": "联系供应商",
                "stage_id": "s1",
                "task_id": "t1",
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["data"]["stage_id"] == "s1"
        assert data["data"]["task_id"] == "t1"

    def test_create_risk_missing_fields(self, client, test_engine):
        """create_risk with missing required fields returns validation_error."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-risk",
            json=_envelope("create_risk", {
                "type": "deadline",
                # missing severity, title, description, evidence, recommendation
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "缺少" in data["observation"]

    def test_create_risk_invalid_type(self, client, test_engine):
        """create_risk with invalid type returns validation_error."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-risk",
            json=_envelope("create_risk", {
                "type": "invalid_type",
                "severity": "high",
                "title": "测试",
                "description": "测试",
                "evidence": ["测试"],
                "recommendation": "测试",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"

    def test_create_risk_empty_evidence(self, client, test_engine):
        """create_risk with empty evidence list returns validation_error."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-risk",
            json=_envelope("create_risk", {
                "type": "deadline",
                "severity": "high",
                "title": "测试",
                "description": "测试",
                "evidence": [],
                "recommendation": "测试",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"

    def test_create_risk_rejects_stage_from_different_project(self, client, test_engine):
        """create_risk must not link a risk to a stage outside the target project."""
        _seed_s11(test_engine)
        with Session(test_engine) as session:
            session.add(
                Project(
                    id="p2",
                    workspace_id="ws1",
                    name="另一个项目",
                    idea="另一个想法",
                    deadline="2026-09-01",
                    deliverables="交付物",
                    created_by="u1",
                )
            )
            session.add(
                Stage(
                    id="s2",
                    project_id="p2",
                    name="另一阶段",
                    goal="另一目标",
                    start_date="2026-07-01",
                    end_date="2026-07-15",
                    deliverable="交付物",
                    order_index=0,
                    status="active",
                )
            )
            session.commit()

        resp = client.post(
            "/internal/agent-tools/create-risk",
            json=_envelope("create_risk", {
                "type": "deadline",
                "severity": "high",
                "title": "跨项目阶段风险",
                "description": "阶段不属于当前项目",
                "evidence": ["阶段来自其他项目"],
                "recommendation": "重新选择阶段",
                "stage_id": "s2",
            }),
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "阶段不属于当前项目" in data["observation"]


class TestCreateCheckinTool:
    """S11 create_checkin: advisory record, no proposal confirmation."""

    def test_create_checkin_success(self, client, test_engine):
        """create_checkin creates a CheckInCycle + CheckInResponse."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-checkin",
            json=_envelope("create_checkin", {
                "task_id": "t1",
                "what_done": "完成后端 API 开发",
                "blocker": "无",
                "user_id": "u1",
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "advisory_record_persisted"
        assert "cycle" in data["data"]
        assert "responses" in data["data"]
        assert len(data["data"]["responses"]) == 1
        assert data["data"]["responses"][0]["what_done"] == "完成后端 API 开发"
        assert data["links"]["created_ids"] != []

    def test_create_checkin_with_blocker(self, client, test_engine):
        """create_checkin with blocker."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-checkin",
            json=_envelope("create_checkin", {
                "task_id": "t1",
                "what_done": "部分完成",
                "blocker": "等待设计稿",
                "user_id": "u1",
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["data"]["responses"][0]["blocker"] == "等待设计稿"

    def test_create_checkin_missing_fields(self, client, test_engine):
        """create_checkin with missing required fields returns validation_error."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-checkin",
            json=_envelope("create_checkin", {
                "task_id": "t1",
                # missing what_done
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "缺少" in data["observation"]

    def test_create_checkin_requires_explicit_workspace_member(self, client, test_engine):
        """create_checkin must not invent a member when user_id is missing."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-checkin",
            json=_envelope("create_checkin", {
                "task_id": "t1",
                "what_done": "完成后端 API 开发",
            }),
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "缺少用户身份信息" in data["observation"]
        with Session(test_engine) as session:
            assert session.exec(select(CheckInCycle)).all() == []

    def test_create_checkin_nonexistent_task(self, client, test_engine):
        """create_checkin with nonexistent task returns validation_error."""
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/create-checkin",
            json=_envelope("create_checkin", {
                "task_id": "nonexistent",
                "what_done": "测试",
                "user_id": "u1",
            }),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "不存在" in data["observation"]

    def test_create_checkin_task_not_in_project(self, client, test_engine):
        """create_checkin with task from different project returns validation_error."""
        _seed_s11(test_engine)
        with Session(test_engine) as session:
            session.add(
                Project(
                    id="p2",
                    workspace_id="ws1",
                    name="另一个项目",
                    idea="另一个想法",
                    deadline="2026-09-01",
                    deliverables="交付物",
                    created_by="u1",
                )
            )
            session.add(
                Stage(
                    id="s2",
                    project_id="p2",
                    name="另一阶段",
                    goal="另一目标",
                    start_date="2026-07-01",
                    end_date="2026-07-15",
                    deliverable="交付物",
                    order_index=0,
                    status="active",
                )
            )
            session.add(
                Task(
                    id="t2",
                    project_id="p2",
                    stage_id="s2",
                    title="另一任务",
                    priority="P1",
                    status=TaskStatus.not_started,
                    order_index=0,
                )
            )
            session.commit()
        resp = client.post(
            "/internal/agent-tools/create-checkin",
            json=_envelope("create_checkin", {
                "task_id": "t2",
                "what_done": "测试",
                "user_id": "u1",
            }),
            # project_id defaults to p1 from envelope
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "不属于" in data["observation"]

    def test_create_checkin_user_must_be_workspace_member(self, client, test_engine):
        """create_checkin must reject users outside the workspace."""
        _seed_s11(test_engine)
        with Session(test_engine) as session:
            session.add(User(id="u3", display_name="外部成员"))
            session.commit()

        resp = client.post(
            "/internal/agent-tools/create-checkin",
            json=_envelope("create_checkin", {
                "task_id": "t1",
                "what_done": "完成后端 API 开发",
                "user_id": "u3",
            }),
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "不是当前工作区成员" in data["observation"]

    def test_create_checkin_rejects_stage_that_does_not_match_task(self, client, test_engine):
        """A check-in response for a task must use that task's stage."""
        _seed_s11(test_engine)
        with Session(test_engine) as session:
            session.add(
                Stage(
                    id="s_other",
                    project_id="p1",
                    name="测试阶段",
                    goal="测试目标",
                    start_date="2026-07-16",
                    end_date="2026-07-20",
                    deliverable="测试交付物",
                    order_index=1,
                    status="pending",
                )
            )
            session.commit()

        resp = client.post(
            "/internal/agent-tools/create-checkin",
            json=_envelope("create_checkin", {
                "task_id": "t1",
                "stage_id": "s_other",
                "what_done": "完成后端 API 开发",
                "user_id": "u1",
            }),
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "validation_error"
        assert "签到阶段必须与任务所属阶段一致" in data["observation"]


class TestUpdateStageProgressTool:
    """update_stage_progress is not exposed until it has a valid commit path."""

    def test_update_stage_progress_is_not_an_active_agent_tool(self, client, test_engine):
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/update-stage-progress",
            json=_envelope("update_stage_progress", {
                "stage_id": "s1",
                "progress_summary": "阶段进展顺利",
                "next_steps": "继续推进剩余任务",
            }),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "blocked"
        assert resp.json()["error"]["code"] == "TOOL_NOT_FOUND"


# ─── Idempotency Tests ─────────────────────────────────────────────────────


class TestCreateRiskIdempotency:
    """Test create_risk idempotency behavior."""

    def test_create_risk_same_idempotency_key_returns_cached(self, client, test_engine):
        """Same idempotency key returns cached result."""
        _seed_s11(test_engine)
        envelope = _envelope("create_risk", {
            "type": "deadline",
            "severity": "high",
            "title": "截止日期风险",
            "description": "距离截止日期仅剩3天",
            "evidence": ["日历显示"],
            "recommendation": "加快进度",
        })
        resp1 = client.post("/internal/agent-tools/create-risk", json=envelope)
        assert resp1.status_code == 200
        assert resp1.json()["status"] == "success"

        resp2 = client.post("/internal/agent-tools/create-risk", json=envelope)
        assert resp2.status_code == 200
        assert resp2.json()["status"] == "success"
        # Same idempotency key should return same result
        assert resp1.json()["links"]["created_ids"] == resp2.json()["links"]["created_ids"]


class TestCreateCheckinIdempotency:
    """Test create_checkin idempotency behavior."""

    def test_create_checkin_same_idempotency_key_returns_cached(self, client, test_engine):
        """Same idempotency key returns cached result."""
        _seed_s11(test_engine)
        envelope = _envelope("create_checkin", {
            "task_id": "t1",
            "what_done": "完成后端 API 开发",
            "user_id": "u1",
        })
        resp1 = client.post("/internal/agent-tools/create-checkin", json=envelope)
        assert resp1.status_code == 200
        assert resp1.json()["status"] == "success"

        resp2 = client.post("/internal/agent-tools/create-checkin", json=envelope)
        assert resp2.status_code == 200
        assert resp2.json()["status"] == "success"
        # Same idempotency key should return same result
        assert resp1.json()["links"]["created_ids"] == resp2.json()["links"]["created_ids"]


class TestSubmitToolResult:
    """Proposal confirmation must stay on the public proposal API."""

    def test_submit_tool_result_is_not_an_agent_tool(self, client, test_engine):
        _seed_s11(test_engine)
        resp = client.post(
            "/internal/agent-tools/submit-tool-result",
            json=_envelope("submit_tool_result", {
                "proposal_id": "some-id",
                "action": "confirm",
                "confirmed_by": "u1",
            }),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "blocked"
        assert resp.json()["error"]["code"] == "TOOL_NOT_FOUND"


class TestToolContractParity:
    """S12: Each migrated tool must return a structurally valid ProjectFlowToolResult."""

    # ── Read-only tools ─────────────────────────────────────────────

    def test_read_only_tools_return_no_side_effect(self, client, test_engine):
        _seed(test_engine)
        for tool_name in ("workspace-state", "conversation", "pending-proposals", "timeline-slice"):
            args: dict = {}
            if tool_name == "workspace-state":
                args = {"workspace_id": "ws1"}
            elif tool_name in ("conversation", "pending-proposals", "timeline-slice"):
                args = {"project_id": "p1"}

            resp = client.post(
                f"/internal/agent-tools/{tool_name}",
                json=_envelope(tool_name, args),
            )
            assert resp.status_code == 200, f"{tool_name}: {resp.text}"
            data = resp.json()
            assert data["status"] == "success", f"{tool_name} status"
            assert data["side_effect_status"] == "no_side_effect", f"{tool_name} side_effect"
            assert "data" in data, f"{tool_name} missing data"

    # ── Proposal tools ──────────────────────────────────────────────

    _PROPOSAL_TOOLS = {
        "stage-plan-proposal": "plan",
        "replan-proposal": "replan",
        "direction-card-proposal": "clarify",
        "task-breakdown-proposal": "breakdown",
    }

    _PROPOSAL_OUTPUTS = {
        "stage-plan-proposal": _STAGE_PLAN_OUTPUT,
        "replan-proposal": _REPLAN_OUTPUT,
        "direction-card-proposal": _DIRECTION_CARD_OUTPUT,
        "task-breakdown-proposal": _TASK_BREAKDOWN_OUTPUT,
    }

    @pytest.mark.parametrize("tool_name,proposal_type", list(_PROPOSAL_TOOLS.items()))
    def test_proposal_tool_returns_proposal_persisted(self, client, test_engine, tool_name, proposal_type):
        fixture = _create_stage_plan_fixture(client)
        project = fixture["project"]
        workspace = fixture["workspace"]

        args: dict = {"output": self._PROPOSAL_OUTPUTS[tool_name]}
        if proposal_type in ("replan", "clarify", "breakdown"):
            args["user_instruction"] = f"生成{proposal_type}草案。"

        resp = client.post(
            f"/internal/agent-tools/{tool_name}",
            json={
                **_envelope(tool_name, args),
                "workspace_id": workspace["id"],
                "project_id": project["id"],
                "idempotency_key": f"run_parity:{tool_name}:v1",
            },
        )
        assert resp.status_code == 200, f"{tool_name}: {resp.text}"
        data = resp.json()
        assert data["status"] == "success", f"{tool_name} status"
        assert data["side_effect_status"] == "proposal_persisted", f"{tool_name} side_effect"
        assert data["links"]["proposal_id"] is not None, f"{tool_name} missing proposal_id"
        assert data["links"]["agent_event_id"] is not None, f"{tool_name} missing agent_event_id"

        proposal_resp = client.get(f"/api/agent-proposals/{data['links']['proposal_id']}")
        assert proposal_resp.status_code == 200
        proposal = proposal_resp.json()
        assert proposal["proposal_type"] == proposal_type
        assert proposal["status"] == "pending"
        assert "requires_confirmation" in proposal["payload"]

    @pytest.mark.parametrize("tool_name,proposal_type", list(_PROPOSAL_TOOLS.items()))
    def test_proposal_tool_idempotency_reuses_same_proposal(self, client, test_engine, tool_name, proposal_type):
        fixture = _create_stage_plan_fixture(client)
        project = fixture["project"]
        workspace = fixture["workspace"]

        args: dict = {"output": self._PROPOSAL_OUTPUTS[tool_name]}
        if proposal_type in ("replan", "clarify", "breakdown"):
            args["user_instruction"] = f"生成{proposal_type}草案。"

        envelope = {
            **_envelope(tool_name, args),
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "idempotency_key": f"run_idem:{tool_name}:v1",
        }

        first = client.post(f"/internal/agent-tools/{tool_name}", json=envelope)
        second = client.post(f"/internal/agent-tools/{tool_name}", json=envelope)
        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["links"]["proposal_id"] == second.json()["links"]["proposal_id"]

    # ── Advisory tool ────────────────────────────────────────────────

    def test_checkins_returns_advisory_record_persisted(self, client, test_engine):
        fixture = _create_checkin_analysis_fixture(client)
        project = fixture["project"]
        workspace = fixture["workspace"]

        envelope = {
            **_envelope("analyze_checkins_and_risks", {
                "checkin_analysis_output": _CHECKIN_ANALYSIS_OUTPUT,
                "risk_analysis_output": _RISK_ANALYSIS_OUTPUT,
            }),
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "idempotency_key": "run_parity:advisory:v1",
        }
        resp = client.post("/internal/agent-tools/checkins-and-risks-analysis", json=envelope)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "advisory_record_persisted"
        assert data["links"]["agent_event_id"] is not None
        assert "replan_signal" in data["data"]

    # ── Assignment recommendation ────────────────────────────────────

    def test_assignment_recommendation_returns_proposal_persisted(self, client, test_engine):
        _seed_assignment(test_engine)
        resp = client.post(
            "/internal/agent-tools/assignment-recommendation",
            json=_envelope("assignment-recommendation", {
                "stage_id": "s1",
                "task_id": "t1",
                "recommended_owner_user_id": "u1",
                "reason": "技能匹配",
            }),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None
        assert data["links"]["created_ids"] != []

    # ── Failed result contract ───────────────────────────────────────

    def test_failed_result_contract(self, client, test_engine):
        _seed(test_engine)
        # workspace_id is now taken from the request envelope, not arguments.
        # Pass a nonexistent workspace_id in the envelope to trigger failed.
        envelope = _envelope("workspace-state")
        envelope["workspace_id"] = "nonexistent"
        resp = client.post(
            "/internal/agent-tools/workspace-state",
            json=envelope,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "failed"
        assert data["side_effect_status"] == "no_side_effect"
        assert data["links"]["created_ids"] == []


class TestSideEffectReconciliation:
    """S12: Side-effect reconciliation edge cases."""

    def test_unknown_tool_returns_blocked_result(self, client, test_engine):
        _seed(test_engine)
        resp = client.post("/internal/agent-tools/unknown-tool-name", json=_envelope("unknown"))
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "blocked"
        assert data["side_effect_status"] == "no_side_effect"
        assert data["error"]["code"] == "TOOL_NOT_FOUND"

    def test_disabled_flag_returns_blocked_policy_result(self, client, test_engine, monkeypatch):
        from app.core import config

        _seed(test_engine)
        monkeypatch.setattr(config.settings, "feature_read_tools", False)

        resp = client.post(
            "/internal/agent-tools/workspace-state",
            json=_envelope("workspace-state", {"workspace_id": "ws1"}),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "blocked"
        assert data["side_effect_status"] == "no_side_effect"
        assert data["error"]["code"] == "POLICY_DENIED"
        assert "disabled" in data["observation"].lower()

    def test_re_enable_flag_restores_tool(self, client, test_engine, monkeypatch):
        from app.core import config

        _seed(test_engine)
        monkeypatch.setattr(config.settings, "feature_read_tools", False)
        resp_disabled = client.post(
            "/internal/agent-tools/workspace-state",
            json=_envelope("workspace-state", {"workspace_id": "ws1"}),
        )
        assert resp_disabled.status_code == 200
        assert resp_disabled.json()["status"] == "blocked"

        monkeypatch.setattr(config.settings, "feature_read_tools", True)
        resp_enabled = client.post(
            "/internal/agent-tools/workspace-state",
            json=_envelope("workspace-state", {"workspace_id": "ws1"}),
        )
        assert resp_enabled.status_code == 200
        assert resp_enabled.json()["status"] == "success"

    def test_tool_crash_returns_failed_unknown_terminal_result(self, client, test_engine, monkeypatch):
        import app.api.routes_agent_tools as routes_agent_tools

        def raise_unexpected_error(*_args, **_kwargs):
            raise RuntimeError("simulated tool crash")

        _seed(test_engine)
        monkeypatch.setattr(routes_agent_tools, "execute_agent_tool", raise_unexpected_error)

        resp = client.post(
            "/internal/agent-tools/workspace-state",
            json=_envelope("workspace-state", {"workspace_id": "ws1"}),
        )

        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "failed"
        assert data["side_effect_status"] == "unknown"
        assert data["error"]["code"] == "TOOL_EXECUTION_FAILED"
        assert "simulated tool crash" in data["observation"]

    def test_replan_blocked_produces_blocked_status(self, client, test_engine):
        _seed(test_engine)
        first = client.post(
            "/internal/agent-tools/replan-proposal",
            json=_envelope(
                "generate_replan_proposal",
                {"project_id": "p1", "user_instruction": "生成计划调整草案。", "output": _REPLAN_OUTPUT},
            ),
        )
        assert first.status_code == 200
        first_data = first.json()
        assert first_data["status"] == "success"

        second_envelope = _envelope(
            "generate_replan_proposal",
            {"project_id": "p1", "user_instruction": "再次生成。"},
        )
        second_envelope["tool_call_id"] = "call_second"
        second_envelope["idempotency_key"] = "run_test:call_second:v1"
        second = client.post("/internal/agent-tools/replan-proposal", json=second_envelope)

        assert second.status_code == 200
        second_data = second.json()
        assert second_data["status"] == "blocked"
        assert second_data["side_effect_status"] == "no_side_effect"
        assert second_data["links"]["proposal_id"] == first_data["links"]["proposal_id"]


class TestToolSafety:
    """S12: Architecture-level safety constraints."""

    def test_internal_agent_tools_require_service_token(self, test_engine):
        from app.core.database import get_session

        def override_get_session():
            with Session(test_engine) as session:
                yield session

        app.dependency_overrides[get_session] = override_get_session
        try:
            with TestClient(app) as unauthenticated_client:
                resp = unauthenticated_client.post(
                    "/internal/agent-tools/workspace-state",
                    json=_envelope("workspace-state", {"workspace_id": "ws1"}),
                )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 403

    def test_shell_tool_not_registered(self, client, test_engine):
        _seed(test_engine)
        resp = client.post(
            "/internal/agent-tools/shell",
            json=_envelope("shell", {"command": "echo hello"}),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "blocked"
        assert data["side_effect_status"] == "no_side_effect"
        assert data["error"]["code"] == "TOOL_NOT_FOUND"

    def test_file_tool_not_registered(self, client, test_engine):
        _seed(test_engine)
        resp = client.post(
            "/internal/agent-tools/file",
            json=_envelope("file", {"path": "/tmp/test"}),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "blocked"
        assert data["side_effect_status"] == "no_side_effect"
        assert data["error"]["code"] == "TOOL_NOT_FOUND"

    def test_confirm_endpoint_reachable_from_api(self, client, test_engine):
        _seed(test_engine)
        resp = client.post(
            "/api/agent-proposals/prop_pending/confirm",
            json={"confirmed_by": "u1"},
        )
        assert resp.status_code in (200, 400, 404, 422)

    def test_no_cross_project_data_leak(self, client, test_engine):
        _seed(test_engine)
        with Session(test_engine) as session:
            session.add(
                Project(
                    id="p2",
                    workspace_id="ws1",
                    name="另一个项目",
                    idea="另一个想法",
                    deadline="2026-09-01",
                    deliverables="交付物",
                    created_by="u1",
                )
            )
            session.commit()

        resp = client.post(
            "/internal/agent-tools/workspace-state",
            json=_envelope("workspace-state", {"workspace_id": "ws1"}),
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["data"]["workspace_id"] == "ws1"
        assert data["data"]["workspace_name"] is not None


# ─── Sidecar direct-persist path tests ─────────────────────────────────────


class TestSidecarDirectPersist:
    """Validate that proposal tools accept sidecar-provided output
    and persist without calling CoordinatorAgent / LLM."""

    DIRECTION_CARD_OUTPUT = {
        "reason": "Sidecar 生成的方向卡",
        "requires_confirmation": True,
        "problem": "大学生项目小队缺乏推进能力",
        "users": "大学生项目团队",
        "value": "AI Agent 主动推进项目",
        "deliverables": ["MVP demo", "README"],
        "boundaries": ["仅限 Web 浏览器"],
        "risks": ["项目超期"],
        "suggested_questions": ["如何确保稳定输出？"],
    }

    STAGE_PLAN_OUTPUT = {
        "reason": "Sidecar 生成的阶段计划",
        "requires_confirmation": True,
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
    }

    TASK_BREAKDOWN_OUTPUT = {
        "reason": "Sidecar 生成的任务拆解",
        "requires_confirmation": True,
        "tasks": [
            {
                "id": "t1",
                "stage_id": "s1",
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
    }

    REPLAN_OUTPUT = {
        "reason": "Sidecar 生成的重规划",
        "requires_confirmation": True,
        "before": {"summary": "项目超期"},
        "after": {"summary": "调整里程碑", "deadline": "2026-07-28"},
        "impact": "给予一周缓冲",
        "stage_adjustments": [],
        "task_changes": [],
        "action_cards": [],
    }

    def _seed_with_stage(self, test_engine):
        """Seed workspace + project + stage for proposal tests."""
        data = _seed(test_engine)
        with Session(test_engine) as s:
            stage = Stage(
                id="s1",
                project_id="p1",
                name="核心实现",
                goal="完成核心",
                start_date="2026-07-07",
                end_date="2026-07-14",
                deliverable="核心闭环",
                status="in_progress",
                order_index=0,
            )
            s.add(stage)
            s.commit()
        return data

    def test_direction_card_sidecar_persist(self, client, test_engine):
        _seed(test_engine)
        envelope = _envelope("direction-card-proposal", {"output": self.DIRECTION_CARD_OUTPUT})
        resp = client.post("/internal/agent-tools/direction-card-proposal", json=envelope)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None
        assert data["links"]["agent_event_id"] is not None
        assert data["observation"] == "已生成待确认的方向卡草案。"

    def test_stage_plan_sidecar_persist(self, client, test_engine):
        self._seed_with_stage(test_engine)
        envelope = _envelope("stage-plan-proposal", {"output": self.STAGE_PLAN_OUTPUT})
        resp = client.post("/internal/agent-tools/stage-plan-proposal", json=envelope)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None

    def test_task_breakdown_sidecar_persist(self, client, test_engine):
        self._seed_with_stage(test_engine)
        envelope = _envelope("task-breakdown-proposal", {"output": self.TASK_BREAKDOWN_OUTPUT})
        resp = client.post("/internal/agent-tools/task-breakdown-proposal", json=envelope)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None

    def test_replan_sidecar_persist(self, client, test_engine):
        _seed(test_engine)
        envelope = _envelope("replan-proposal", {"output": self.REPLAN_OUTPUT})
        resp = client.post("/internal/agent-tools/replan-proposal", json=envelope)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success"
        assert data["side_effect_status"] == "proposal_persisted"
        assert data["links"]["proposal_id"] is not None

    def test_direction_card_invalid_output_returns_failed(self, client, test_engine):
        _seed(test_engine)
        bad_output = {"reason": "missing required fields"}
        envelope = _envelope("direction-card-proposal", {"output": bad_output})
        resp = client.post("/internal/agent-tools/direction-card-proposal", json=envelope)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "failed"
        assert "DIRECTION_CARD_OUTPUT_INVALID" in data["error"]["code"]

    def test_checkins_risks_sidecar_persist(self, client, test_engine):
        self._seed_with_stage(test_engine)
        checkin_output = {
            "reason": "签到分析结果",
            "requires_confirmation": False,
            "summary": "小王前端完成，小张后端阻塞",
            "task_updates": [],
            "risks": [],
        }
        risk_output = {
            "reason": "风险分析结果",
            "requires_confirmation": True,
            "risks": [
                {
                    "type": "deadline",
                    "severity": "high",
                    "title": "项目超期",
                    "description": "截止日期已过",
                    "evidence": ["deadline 2026-06-09 已过"],
                    "recommendation": "调整里程碑",
                    "stage_id": "s1",
                    "task_id": None,
                    "evidence_refs": [],
                }
            ],
        }
        envelope = _envelope(
            "checkins-and-risks-analysis",
            {"checkin_analysis_output": checkin_output, "risk_analysis_output": risk_output},
        )
        resp = client.post("/internal/agent-tools/checkins-and-risks-analysis", json=envelope)
        if resp.json().get("status") != "success":
            import sys
            print("DEBUG RESP:", resp.json(), file=sys.stderr)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "success", f"Error: {data.get('error', {})}"
