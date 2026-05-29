from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def _create_execution_fixture():
    owner = client.post("/api/users", json={"display_name": "Checkin Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Checkin Member"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Execution Workspace"},
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
            "name": "Execution Project",
            "idea": "Keep execution moving",
            "deadline": "2026-06-07",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Build",
            "goal": "Finish execution loop",
            "start_date": "2026-05-29",
            "end_date": "2026-06-01",
            "deliverable": "Working backend",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Handle blockers",
            "description": "Capture blocker and replan",
            "priority": "P0",
            "due_date": "2026-05-31",
            "estimated_hours": 6,
        },
    ).json()
    return workspace, project, stage, task, owner, member


def test_checkin_risk_and_replan_confirmation_flow():
    workspace, project, stage, task, owner, member = _create_execution_fixture()

    cycle_response = client.post(
        "/api/checkin-cycles",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "cadence_days": 2,
            "start_date": "2026-05-29",
            "created_by_user_id": owner["id"],
        },
    )
    assert cycle_response.status_code == 201
    cycle = cycle_response.json()
    assert cycle["next_due_date"] == "2026-05-31"

    checkin_response = client.post(
        f"/api/checkin-cycles/{cycle['id']}/responses",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "user_id": member["id"],
            "task_id": task["id"],
            "what_done": "Finished API draft",
            "blocker": "Need schema decision",
            "available_hours_next_cycle": 2,
            "mood_or_confidence": "low",
        },
    )
    assert checkin_response.status_code == 201
    assert checkin_response.json()["blocker"] == "Need schema decision"

    status_update_response = client.post(
        f"/api/tasks/{task['id']}/status-updates",
        json={
            "task_id": task["id"],
            "user_id": member["id"],
            "status": "blocked",
            "progress_note": "Blocked by schema decision",
            "blocker": "Need schema decision",
            "available_hours_change": -3,
        },
    )
    assert status_update_response.status_code == 201
    assert status_update_response.json()["available_hours_change"] == -3

    risk_response = client.post(
        "/api/risks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task["id"],
            "type": "dependency",
            "severity": "high",
            "title": "Schema decision blocks task",
            "description": "The member reported a blocker during check-in.",
            "evidence": [{"source": "checkin", "text": "Need schema decision"}],
            "recommendation": "Resolve the schema decision before continuing.",
            "created_by_agent": True,
        },
    )
    assert risk_response.status_code == 201
    assert risk_response.json()["evidence"][0]["source"] == "checkin"

    replan_response = client.post(
        "/api/replans/confirm",
        json={
            "project_id": project["id"],
            "before": {"task_due_date": "2026-05-31"},
            "after": {"task_due_date": "2026-06-02"},
            "impact": "Moves the blocked task by two days and adds an owner action.",
            "reason": "The blocker reduces member availability.",
            "requires_confirmation": True,
            "stage_adjustments": [
                {
                    "stage_id": stage["id"],
                    "new_end_date": "2026-06-03",
                    "reason": "Stage needs buffer for blocker resolution.",
                }
            ],
            "task_changes": [
                {
                    "task_id": task["id"],
                    "status": "blocked",
                    "due_date": "2026-06-02",
                    "can_cut": True,
                    "reason": "Task is blocked and may need scope cut.",
                }
            ],
            "action_cards": [
                {
                    "project_id": project["id"],
                    "stage_id": stage["id"],
                    "task_id": task["id"],
                    "user_id": member["id"],
                    "type": "risk_action",
                    "title": "Resolve schema decision",
                    "content": "Make the schema decision before the next check-in.",
                    "reason": "The blocker is now on the critical path.",
                    "created_by_agent": True,
                }
            ],
        },
    )
    assert replan_response.status_code == 200
    replan = replan_response.json()
    assert replan["confirmed"] is True
    assert replan["requires_confirmation"] is True
    assert replan["before"]["task_due_date"] == "2026-05-31"
    assert replan["after"]["task_due_date"] == "2026-06-02"
    assert replan["impact"] == "Moves the blocked task by two days and adds an owner action."
    assert task["id"] in replan["applied_task_ids"]
    assert stage["id"] in replan["applied_stage_ids"]
    assert len(replan["created_action_card_ids"]) == 1

    updated_task = client.get(f"/api/tasks/{task['id']}").json()
    assert updated_task["status"] == "blocked"
    assert updated_task["due_date"] == "2026-06-02"
    assert updated_task["can_cut"] is True

    action_cards = client.get(f"/api/projects/{project['id']}/action-cards").json()
    assert action_cards[0]["reason"] == "The blocker is now on the critical path."
