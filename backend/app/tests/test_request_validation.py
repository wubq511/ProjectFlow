"""Request schema boundary tests."""

from datetime import date, timedelta

from fastapi.testclient import TestClient


def test_user_create_rejects_blank_display_name(client: TestClient):
    response = client.post("/api/users", json={"display_name": "   "})

    assert response.status_code == 422


def test_user_create_rejects_invalid_email(client: TestClient):
    response = client.post("/api/users", json={"display_name": "Robert", "email": "not-an-email"})

    assert response.status_code == 422


def test_workspace_create_rejects_blank_name(client: TestClient):
    user = client.post("/api/users", json={"display_name": "Owner"}).json()

    response = client.post("/api/workspaces", json={"name": ""}, params={"owner_user_id": user["id"]})

    assert response.status_code == 422


def test_project_create_rejects_past_deadline(client: TestClient):
    past_date = date.today() - timedelta(days=1)
    if past_date == date(2026, 7, 15):
        past_date = date.today() - timedelta(days=2)
    yesterday = past_date.isoformat()

    response = client.post(
        "/api/projects",
        json={
            "workspace_id": "workspace-id",
            "name": "Project",
            "idea": "Build a demo",
            "deadline": yesterday,
            "deliverables": "Demo",
            "created_by": "user-id",
        },
    )

    assert response.status_code == 422


def test_stage_create_rejects_end_date_before_start_date(client: TestClient):
    response = client.post(
        "/api/stages",
        json={
            "project_id": "project-id",
            "name": "Build",
            "goal": "Finish the demo",
            "start_date": "2026-06-02",
            "end_date": "2026-06-01",
            "deliverable": "Demo",
        },
    )

    assert response.status_code == 422


def test_task_create_rejects_negative_estimated_hours(client: TestClient):
    response = client.post(
        "/api/tasks",
        json={
            "project_id": "project-id",
            "stage_id": "stage-id",
            "title": "Task",
            "description": "Do the work",
            "due_date": "2026-06-01",
            "estimated_hours": -1,
        },
    )

    assert response.status_code == 422


def test_member_profile_rejects_negative_available_hours(client: TestClient):
    response = client.post(
        "/api/member-profiles",
        json={
            "user_id": "user-id",
            "workspace_id": "workspace-id",
            "available_hours_per_week": -1,
        },
    )

    assert response.status_code == 422


def test_checkin_cycle_rejects_nonpositive_cadence(client: TestClient):
    response = client.post(
        "/api/checkin-cycles",
        json={
            "project_id": "project-id",
            "stage_id": "stage-id",
            "cadence_days": 0,
            "start_date": "2026-06-01",
            "created_by_user_id": "user-id",
        },
    )

    assert response.status_code == 422
