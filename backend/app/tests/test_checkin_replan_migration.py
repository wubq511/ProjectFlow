"""Regression tests for S9 check-in to replan proposal migration."""

from fastapi.testclient import TestClient


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
    return workspace, project, task


def test_checkin_task_updates_create_replan_proposal_without_mutating_task(client: TestClient):
    workspace, project, task = _create_blocked_checkin_fixture(client)

    response = client.post(
        "/api/agent/check-in-analysis",
        json={"workspace_id": workspace["id"], "project_id": project["id"]},
    )

    assert response.status_code == 200, response.text
    result = response.json()
    assert result["event_type"] == "checkin"
    assert result["proposal_id"] is not None

    task_after = client.get(f"/api/tasks/{task['id']}").json()
    assert task_after["status"] == "not_started"

    proposal_response = client.get(f"/api/agent-proposals/{result['proposal_id']}")
    assert proposal_response.status_code == 200, proposal_response.text
    proposal = proposal_response.json()
    assert proposal["proposal_type"] == "replan"
    assert proposal["status"] == "pending"
    assert proposal["payload"]["requires_confirmation"] is True
    assert proposal["payload"]["task_changes"][0]["task_id"] == task["id"]
    assert proposal["payload"]["task_changes"][0]["status"] == "blocked"
