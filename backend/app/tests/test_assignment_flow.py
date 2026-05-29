from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def _create_assignment_fixture():
    owner = client.post("/api/users", json={"display_name": "Assignment Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Assignment Member"}).json()
    backup = client.post("/api/users", json={"display_name": "Assignment Backup"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Assignment Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": member["id"], "role": "member"},
    )
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": backup["id"], "role": "member"},
    )
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Assignment Project",
            "idea": "Coordinate task ownership",
            "deadline": "2026-06-07",
            "deliverables": "Backend flow",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Execution",
            "goal": "Ship assignment flow",
            "start_date": "2026-05-29",
            "end_date": "2026-06-02",
            "deliverable": "Working assignment API",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Build assignment flow",
            "description": "Proposal, response, negotiation, and finalize",
            "priority": "P0",
            "due_date": "2026-05-31",
            "estimated_hours": 4,
        },
    ).json()
    return project, stage, task, member, backup


def test_assignment_proposal_response_negotiation_and_finalize_updates_owner_after_confirmation():
    project, stage, task, member, backup = _create_assignment_fixture()

    proposal_response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task["id"],
            "recommended_owner_user_id": member["id"],
            "backup_owner_user_id": backup["id"],
            "reason": "Member has the strongest backend fit.",
            "risk_note": "Backup keeps the work covered.",
            "created_by_agent": True,
        },
    )
    assert proposal_response.status_code == 201
    proposal = proposal_response.json()
    assert proposal["status"] == "proposed"

    task_before_confirmation = client.get(f"/api/tasks/{task['id']}").json()
    assert task_before_confirmation["owner_user_id"] is None

    unauthorized_response = client.post(
        f"/api/assignment-proposals/{proposal['id']}/responses",
        json={
            "user_id": backup["id"],
            "response": "accept",
            "reason": "I am not the recommended owner.",
        },
    )
    assert unauthorized_response.status_code == 400

    response = client.post(
        f"/api/assignment-proposals/{proposal['id']}/responses",
        json={
            "user_id": member["id"],
            "response": "accept",
            "reason": "I can take this.",
        },
    )
    assert response.status_code == 201
    assert response.json()["response"] == "accept"

    proposal_after_response = client.get(f"/api/assignment-proposals/{proposal['id']}").json()
    assert proposal_after_response["status"] == "owner_confirmed"

    task_after_response = client.get(f"/api/tasks/{task['id']}").json()
    assert task_after_response["owner_user_id"] is None

    finalized = client.post(f"/api/assignment-proposals/{proposal['id']}/finalize")
    assert finalized.status_code == 200
    assert finalized.json()["status"] == "finalized"

    task_after_finalize = client.get(f"/api/tasks/{task['id']}").json()
    assert task_after_finalize["owner_user_id"] == member["id"]
    assert task_after_finalize["backup_owner_user_id"] == backup["id"]
    assert task_after_finalize["assignment_reason"] == "Member has the strongest backend fit."

    negotiation = client.post(
        "/api/assignment-negotiations",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "from_user_id": backup["id"],
            "desired_task_id": task["id"],
            "current_owner_user_id": member["id"],
            "agent_message": "Ask the confirmed owner before swapping.",
        },
    )
    assert negotiation.status_code == 201
    assert negotiation.json()["status"] == "pending"
