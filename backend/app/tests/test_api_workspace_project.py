"""Full-path smoke tests: account -> workspace -> profile -> project -> stage -> task -> workspace_state."""
from fastapi.testclient import TestClient


def test_full_demo_path(client: TestClient):
    # 1. Create user
    user_resp = client.post("/api/users", json={"display_name": "Alice", "email": "alice@test.com"})
    assert user_resp.status_code == 201
    user_id = user_resp.json()["id"]

    # 2. Create workspace
    ws_resp = client.post(
        "/api/workspaces",
        json={"name": "Team Alpha", "description": "Demo team"},
        params={"owner_user_id": user_id},
    )
    assert ws_resp.status_code == 201
    ws_data = ws_resp.json()
    ws_id = ws_data["id"]
    assert ws_data["owner_user_id"] == user_id

    # 3. Invite a member
    inv_resp = client.post(
        "/api/invitations",
        json={"workspace_id": ws_id, "invited_name": "Bob", "invited_email": "bob@test.com"},
    )
    assert inv_resp.status_code == 201
    inv_token = inv_resp.json()["token"]

    # 4. Accept invitation
    accept_resp = client.post("/api/invitations/accept", json={"token": inv_token})
    assert accept_resp.status_code == 200
    assert accept_resp.json()["status"] == "accepted"

    # 5. Create member profile for owner
    profile_resp = client.post(
        "/api/member-profiles",
        json={
            "user_id": user_id,
            "workspace_id": ws_id,
            "skills": [{"name": "backend", "level": 4}],
            "available_hours_per_week": 10,
            "role_preference": "developer",
            "interests": "AI agents",
            "constraints": "weekends only",
        },
    )
    assert profile_resp.status_code == 201
    profile_id = profile_resp.json()["id"]

    # 6. Update profile
    patch_resp = client.patch(
        f"/api/member-profiles/{profile_id}",
        json={"available_hours_per_week": 15, "interests": "AI agents, system design"},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["available_hours_per_week"] == 15

    # 7. Create project
    proj_resp = client.post(
        "/api/projects",
        json={
            "workspace_id": ws_id,
            "name": "ProjectFlow",
            "idea": "AI agent for college teams",
            "deadline": "2026-06-07",
            "deliverables": "MVP demo",
            "created_by": user_id,
        },
    )
    assert proj_resp.status_code == 201
    proj_id = proj_resp.json()["id"]

    # 8. Add resource
    res_resp = client.post(
        "/api/resources",
        json={
            "project_id": proj_id,
            "type": "text_note",
            "title": "Background notes",
            "content_text": "Some context about the project",
        },
    )
    assert res_resp.status_code == 201

    # 9. Create stage
    stage_resp = client.post(
        "/api/stages",
        json={
            "project_id": proj_id,
            "name": "Phase 1",
            "goal": "Build core APIs",
            "start_date": "2026-05-28",
            "end_date": "2026-06-01",
            "deliverable": "Working API layer",
            "done_criteria": ["All P0 endpoints pass smoke tests"],
            "order_index": 0,
        },
    )
    assert stage_resp.status_code == 201
    stage_id = stage_resp.json()["id"]

    # 10. Create task
    task_resp = client.post(
        "/api/tasks",
        json={
            "project_id": proj_id,
            "stage_id": stage_id,
            "title": "Implement workspace API",
            "description": "Build CRUD endpoints for workspaces",
            "priority": "P0",
            "due_date": "2026-05-30",
            "estimated_hours": 4,
        },
    )
    assert task_resp.status_code == 201
    task_id = task_resp.json()["id"]

    # 11. Update task status
    status_update_resp = client.post(
        f"/api/tasks/{task_id}/status-updates",
        json={
            "task_id": task_id,
            "user_id": user_id,
            "status": "in_progress",
            "progress_note": "Started implementation",
        },
    )
    assert status_update_resp.status_code == 201

    # 12. Get workspace state
    state_resp = client.get(f"/api/workspaces/{ws_id}/state")
    assert state_resp.status_code == 200
    state = state_resp.json()
    assert state["workspace_id"] == ws_id
    assert state["workspace_name"] == "Team Alpha"
    assert len(state["members"]) >= 1
    assert state["project"] is not None
    assert state["project"]["id"] == proj_id
    assert state["project"]["deliverables"] == "MVP demo"
    assert len(state["project"]["stages"]) == 1
    assert state["project"]["stages"][0]["deliverable"] == "Working API layer"
    assert state["project"]["stages"][0]["done_criteria"] == ["All P0 endpoints pass smoke tests"]
    assert len(state["project"]["tasks"]) == 1
    assert state["project"]["tasks"][0]["description"] == "Build CRUD endpoints for workspaces"
    assert state["project"]["tasks"][0]["estimated_hours"] == 4
    assert state["project"]["tasks"][0]["status"] == "in_progress"


def test_workspace_state_not_found(client: TestClient):
    resp = client.get("/api/workspaces/nonexistent-id/state")
    assert resp.status_code == 404


def test_list_endpoints(client: TestClient):
    """Verify list endpoints return data after creation."""
    # Create a user and workspace
    user_resp = client.post("/api/users", json={"display_name": "ListTest"})
    user_id = user_resp.json()["id"]

    ws_resp = client.post(
        "/api/workspaces",
        json={"name": "List WS"},
        params={"owner_user_id": user_id},
    )
    ws_id = ws_resp.json()["id"]

    # List users
    users = client.get("/api/users").json()
    assert len(users) >= 1

    # List workspaces
    workspaces = client.get("/api/workspaces").json()
    assert len(workspaces) >= 1

    # List profiles (empty)
    profiles = client.get(f"/api/workspaces/{ws_id}/profiles").json()
    assert isinstance(profiles, list)

    # Create project and list
    proj_resp = client.post(
        "/api/projects",
        json={
            "workspace_id": ws_id,
            "name": "ListProj",
            "idea": "test",
            "deadline": "2026-06-07",
            "deliverables": "demo",
            "created_by": user_id,
        },
    )
    proj_id = proj_resp.json()["id"]

    projects = client.get(f"/api/workspaces/{ws_id}/projects").json()
    assert len(projects) >= 1

    # Create stage and list
    stage_resp = client.post(
        "/api/stages",
        json={
            "project_id": proj_id,
            "name": "S1",
            "goal": "g",
            "start_date": "2026-05-28",
            "end_date": "2026-06-01",
            "deliverable": "d",
        },
    )
    stage_id = stage_resp.json()["id"]

    stages = client.get(f"/api/projects/{proj_id}/stages").json()
    assert len(stages) >= 1

    # Create task and list
    task_resp = client.post(
        "/api/tasks",
        json={
            "project_id": proj_id,
            "stage_id": stage_id,
            "title": "T1",
            "description": "desc",
            "due_date": "2026-05-30",
        },
    )
    task_id = task_resp.json()["id"]

    tasks_by_stage = client.get(f"/api/stages/{stage_id}/tasks").json()
    assert len(tasks_by_stage) >= 1

    tasks_by_project = client.get(f"/api/projects/{proj_id}/tasks").json()
    assert len(tasks_by_project) >= 1

    # Get individual resources
    assert client.get(f"/api/projects/{proj_id}").status_code == 200
    assert client.get(f"/api/stages/{stage_id}").status_code == 200
    assert client.get(f"/api/tasks/{task_id}").status_code == 200
    assert client.get(f"/api/users/{user_id}").status_code == 200
    assert client.get(f"/api/workspaces/{ws_id}").status_code == 200
