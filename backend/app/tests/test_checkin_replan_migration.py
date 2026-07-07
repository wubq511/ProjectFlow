"""Regression tests for S9 check-in to replan proposal migration."""

import uuid

from fastapi.testclient import TestClient


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


def _create_blocked_checkin_fixture(client: TestClient):
    owner = client.post("/api/users", json={"display_name": "负责人"}).json()
    member = client.post("/api/users", json={"display_name": "小林"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "S9 工作区"},
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
            "name": "S9 项目",
            "idea": "验证签到推断不直接修改任务状态",
            "deadline": "2026-08-01",
            "deliverables": "可演示闭环",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "实现阶段",
            "goal": "完成后端接口",
            "start_date": "2026-07-01",
            "end_date": "2026-07-15",
            "deliverable": "后端 API",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "后端 API 与数据模型",
            "description": "实现关键接口",
            "priority": "P0",
            "due_date": "2026-07-10",
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
            "what_done": "完成了接口草稿",
            "blocker": "数据库字段还没有确认",
            "available_hours_next_cycle": 3,
            "mood_or_confidence": "medium",
        },
    )
    return workspace, project, stage, task, owner, member


def test_checkin_task_updates_create_replan_proposal_without_mutating_task(client: TestClient):
    workspace, project, stage, task, owner, member = _create_blocked_checkin_fixture(client)

    # Step 1: Run checkins-and-risks-analysis (advisory — no replan proposal created yet)
    checkin_analysis_output = {
        "reason": "签到分析结果",
        "requires_confirmation": False,
        "summary": "后端任务受阻，需要调整计划",
        "task_updates": [
            {
                "task_id": task["id"],
                "status": "blocked",
                "reason": "数据库字段未确认导致受阻",
            }
        ],
        "risks": [],
    }
    risk_analysis_output = {
        "reason": "风险分析结果",
        "requires_confirmation": True,
        "risks": [
            {
                "type": "dependency",
                "severity": "high",
                "title": "后端任务受阻",
                "description": "数据库字段未确认",
                "evidence": ["签到报告受阻"],
                "recommendation": "调整计划",
                "stage_id": stage["id"],
                "task_id": task["id"],
                "evidence_refs": [],
            }
        ],
    }
    envelope = _tool_envelope(
        "checkins-and-risks-analysis", workspace["id"], project["id"],
        {"checkin_analysis_output": checkin_analysis_output, "risk_analysis_output": risk_analysis_output},
    )
    checkin_resp = client.post("/internal/agent-tools/checkins-and-risks-analysis", json=envelope)
    assert checkin_resp.status_code == 200, checkin_resp.text

    # Step 2: Run replan-proposal to create the actual replan proposal
    replan_output = {
        "before": {"summary": "当前计划"},
        "after": {"summary": "调整后计划", "deadline": "2026-08-15"},
        "impact": "给予一周缓冲以解决数据库字段确认问题",
        "stage_adjustments": [],
        "task_changes": [
            {
                "task_id": task["id"],
                "status": "blocked",
                "reason": "数据库字段未确认导致受阻",
            }
        ],
        "action_cards": [],
        "reason": "签到发现后端任务受阻，需要调整计划",
        "requires_confirmation": True,
    }
    replan_envelope = _tool_envelope(
        "replan-proposal", workspace["id"], project["id"],
        {"output": replan_output},
    )
    replan_resp = client.post("/internal/agent-tools/replan-proposal", json=replan_envelope)
    assert replan_resp.status_code == 200, replan_resp.text
    result = replan_resp.json()
    proposal_id = result["links"]["proposal_id"]
    assert proposal_id is not None

    # Task should NOT be mutated (unconfirmed proposal)
    task_after = client.get(f"/api/tasks/{task['id']}").json()
    assert task_after["status"] == "not_started"

    proposal_response = client.get(f"/api/agent-proposals/{proposal_id}")
    assert proposal_response.status_code == 200, proposal_response.text
    proposal = proposal_response.json()
    assert proposal["proposal_type"] == "replan"
    assert proposal["status"] == "pending"
    assert proposal["payload"]["requires_confirmation"] is True
    assert proposal["payload"]["task_changes"][0]["task_id"] == task["id"]
    assert proposal["payload"]["task_changes"][0]["status"] == "blocked"
