"""Phase 0 contract tests for legacy JSON and durable evidence references."""

from datetime import date, timedelta

from fastapi.testclient import TestClient


def _create_project_graph(client: TestClient) -> dict[str, str]:
    owner = client.post("/api/users", json={"display_name": "契约测试负责人"}).json()
    workspace = client.post(
        "/api/workspaces",
        params={"owner_user_id": owner["id"]},
        json={"name": "契约测试工作区", "team_size": 3, "project_template": "research"},
    ).json()
    deadline = date.today() + timedelta(days=60)
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "数据契约测试项目",
            "idea": "验证结构化事实可以完整往返",
            "deadline": deadline.isoformat(),
            "deliverables": "测试报告",
            "created_by": owner["id"],
            "project_template": "research",
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "验证阶段",
            "goal": "固定契约",
            "start_date": date.today().isoformat(),
            "end_date": (date.today() + timedelta(days=30)).isoformat(),
            "deliverable": "契约快照",
            "done_criteria": ["所有往返断言通过"],
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "验证 EvidenceRef",
            "description": "检查结构化依据落库并重新读取",
            "priority": "P0",
            "due_date": (date.today() + timedelta(days=20)).isoformat(),
            "estimated_hours": 4,
        },
    ).json()
    return {
        "owner_id": owner["id"],
        "workspace_id": workspace["id"],
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
    }


def test_evidence_refs_survive_create_list_state_and_agent_state(client: TestClient) -> None:
    ids = _create_project_graph(client)
    evidence_refs = [
        {
            "entity_type": "task",
            "entity_id": ids["task_id"],
            "field": "priority",
            "value": "P0",
        }
    ]

    assignment = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": ids["project_id"],
            "stage_id": ids["stage_id"],
            "task_id": ids["task_id"],
            "recommended_owner_user_id": ids["owner_id"],
            "reason": "负责人具备完成该任务的条件",
            "evidence_refs": evidence_refs,
        },
    )
    assert assignment.status_code == 201
    assert assignment.json()["evidence_refs"] == evidence_refs

    risk = client.post(
        "/api/risks",
        json={
            "project_id": ids["project_id"],
            "stage_id": ids["stage_id"],
            "task_id": ids["task_id"],
            "type": "deadline",
            "severity": "medium",
            "title": "关键任务时间有限",
            "description": "P0 任务需要在阶段结束前完成",
            "evidence": ["任务优先级为 P0"],
            "evidence_refs": evidence_refs,
            "recommendation": "优先完成该任务",
        },
    )
    assert risk.status_code == 201
    assert risk.json()["evidence_refs"] == evidence_refs

    action_card = client.post(
        "/api/action-cards",
        json={
            "project_id": ids["project_id"],
            "stage_id": ids["stage_id"],
            "task_id": ids["task_id"],
            "type": "team_next_step",
            "title": "先完成关键任务",
            "content": "今天确认实现范围",
            "reason": "该任务为 P0",
            "evidence_refs": evidence_refs,
        },
    )
    assert action_card.status_code == 201
    assert action_card.json()["evidence_refs"] == evidence_refs

    proposal_id = assignment.json()["id"]
    assert client.get(f"/api/assignment-proposals/{proposal_id}").json()["evidence_refs"] == evidence_refs
    assert client.get(
        f"/api/projects/{ids['project_id']}/assignment-proposals"
    ).json()[0]["evidence_refs"] == evidence_refs
    assert client.get(f"/api/projects/{ids['project_id']}/risks").json()[0]["evidence_refs"] == evidence_refs
    assert client.get(
        f"/api/projects/{ids['project_id']}/action-cards"
    ).json()[0]["evidence_refs"] == evidence_refs

    project_state = client.get(f"/api/projects/{ids['project_id']}/state").json()
    assert project_state["assignment_proposals"][0]["evidence_refs"] == evidence_refs
    assert project_state["risks"][0]["evidence_refs"] == evidence_refs
    assert project_state["action_cards"][0]["evidence_refs"] == evidence_refs

    agent_state = client.get(
        f"/api/workspaces/{ids['workspace_id']}/state",
        params={"project_id": ids["project_id"]},
    ).json()
    assert agent_state["project"]["assignment_proposals"][0]["evidence_refs"] == evidence_refs


def test_legacy_direction_card_json_is_normalized_on_every_read_path(client: TestClient) -> None:
    ids = _create_project_graph(client)
    legacy_card = {
        "problem": "团队目标不清晰",
        "target_users": "大学生项目团队",
        "core_value": "把项目状态转化为下一步行动",
        "deliverables": ["可运行原型"],
        "constraints": ["保留现有架构"],
        "out_of_scope": ["不新增多 Agent Runtime"],
        "initial_risks": ["截止日期风险"],
        "suggested_questions": ["首先验证什么？"],
    }

    updated = client.patch(
        f"/api/projects/{ids['project_id']}",
        json={"direction_card": legacy_card},
    )
    assert updated.status_code == 200

    expected = {
        "problem": "团队目标不清晰",
        "users": "大学生项目团队",
        "value": "把项目状态转化为下一步行动",
        "deliverables": ["可运行原型"],
        "boundaries": ["保留现有架构", "不新增多 Agent Runtime"],
        "risks": ["截止日期风险"],
        "suggested_questions": ["首先验证什么？"],
    }
    assert updated.json()["direction_card"] == expected
    assert client.get(f"/api/projects/{ids['project_id']}").json()["direction_card"] == expected
    assert client.get(f"/api/projects/{ids['project_id']}/state").json()["project"]["direction_card"] == expected
    agent_state = client.get(
        f"/api/workspaces/{ids['workspace_id']}/state",
        params={"project_id": ids["project_id"]},
    ).json()
    assert agent_state["project"]["direction_card"] == expected


def test_review_summary_public_contract_and_export_event_are_stable(client: TestClient) -> None:
    seed = client.post("/api/seed/demo")
    assert seed.status_code == 200

    response = client.post("/api/projects/demo-project-001/export/review-summary")
    assert response.status_code == 200
    assert set(response.json()) == {"markdown"}
    markdown = response.json()["markdown"]
    for section in ("产品定位", "当前状态", "任务状态", "团队", "风险", "Agent 决策时间线"):
        assert section in markdown

    timeline = client.get("/api/projects/demo-project-001/timeline").json()
    export_events = [event for event in timeline if event["event_type"] == "export"]
    assert len(export_events) == 1
    assert export_events[0]["output_snapshot"]["markdown_length"] == len(markdown)
