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
    )
    SQLModel.metadata.create_all(engine)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _create_agent_fixture(client: TestClient):
    owner = client.post("/api/users", json={"display_name": "Agent Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Agent Member"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Agent Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": member["id"], "role": "member"},
    )
    client.post(
        "/api/member-profiles",
        json={
            "user_id": member["id"],
            "workspace_id": workspace["id"],
            "skills": ["backend"],
            "available_hours_per_week": 8,
            "role_preference": "backend",
            "interests": "APIs",
            "constraints": "",
        },
    )
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Agent Project",
            "idea": "Use agent proposals",
            "deadline": "2026-06-07",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Agent Stage",
            "goal": "Generate proposals",
            "start_date": "2026-05-29",
            "end_date": "2026-06-02",
            "deliverable": "Agent output",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Agent task",
            "description": "Task for agent fallback",
            "priority": "P0",
            "due_date": "2026-05-31",
            "estimated_hours": 3,
        },
    ).json()
    return workspace, project, stage, task


def test_agent_endpoints_exist_and_persist_execution_proposals(client: TestClient):
    workspace, project, stage, task = _create_agent_fixture(client)

    for path in [
        "/api/agent/clarify",
        "/api/agent/plan",
        "/api/agent/breakdown",
        "/api/agent/risk-analysis",
        "/api/agent/replan",
    ]:
        response = client.post(path, json={"workspace_id": workspace["id"]})
        assert response.status_code == 200
        assert response.json()["used_fallback"] is True
        assert response.json()["output"]["reason"]

    assignment_response = client.post("/api/agent/assign", json={"workspace_id": workspace["id"]})
    assert assignment_response.status_code == 200
    assert assignment_response.json()["created_ids"]

    proposals = client.get(f"/api/projects/{project['id']}/assignment-proposals").json()
    assert proposals[0]["task_id"] == task["id"]
    assert proposals[0]["status"] == "proposed"

    push_response = client.post("/api/agent/active-push", json={"workspace_id": workspace["id"]})
    assert push_response.status_code == 200
    assert push_response.json()["created_ids"]

    action_cards = client.get(f"/api/projects/{project['id']}/action-cards").json()
    assert action_cards[0]["reason"]

    checkin_response = client.post("/api/agent/check-in-analysis", json={"workspace_id": workspace["id"]})
    assert checkin_response.status_code == 200
    assert checkin_response.json()["created_ids"]

    replan_output = client.post("/api/agent/replan", json={"workspace_id": workspace["id"]}).json()
    assert replan_output["output"]["requires_confirmation"] is True
    assert "before" in replan_output["output"]
    assert "after" in replan_output["output"]
    assert "impact" in replan_output["output"]
