"""Project template and workspace metadata survive create and read paths."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def owner_and_workspace(client: TestClient) -> tuple[str, str]:
    user = client.post("/api/users", json={"display_name": "项目创建者"})
    assert user.status_code == 201
    user_id = user.json()["id"]
    response = client.post(
        "/api/workspaces",
        params={"owner_user_id": user_id},
        json={
            "name": "项目工作区",
            "team_size": 5,
            "use_case": "competition",
        },
    )
    assert response.status_code == 201
    workspace = response.json()
    assert workspace["team_size"] == 5
    assert workspace["use_case"] == "competition"
    return user_id, workspace["id"]


@pytest.mark.parametrize("project_template", ["coursework", "competition", "startup", "research"])
def test_project_template_survives_all_read_paths(
    client: TestClient,
    owner_and_workspace: tuple[str, str],
    project_template: str,
) -> None:
    user_id, workspace_id = owner_and_workspace
    response = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace_id,
            "name": "参赛项目",
            "idea": "验证项目类型的完整读取链路",
            "deadline": (date.today() + timedelta(days=30)).isoformat(),
            "deliverables": "可运行原型",
            "created_by": user_id,
            "project_template": project_template,
        },
    )
    assert response.status_code == 201
    project_id = response.json()["id"]
    assert response.json()["project_template"] == project_template

    assert client.get(f"/api/projects/{project_id}").json()["project_template"] == project_template
    projects = client.get(f"/api/workspaces/{workspace_id}/projects").json()
    assert projects[0]["project_template"] == project_template
    state = client.get(f"/api/projects/{project_id}/state").json()
    assert state["project"]["project_template"] == project_template
    assert state["workspace"]["team_size"] == 5
    assert state["workspace"]["use_case"] == "competition"
    agent_state = client.get(
        f"/api/workspaces/{workspace_id}/state",
        params={"project_id": project_id},
    ).json()
    assert agent_state["project"]["project_template"] == project_template

    workspace = client.get(f"/api/workspaces/{workspace_id}").json()
    assert workspace["team_size"] == 5
    assert workspace["use_case"] == "competition"
    listed = client.get("/api/workspaces").json()
    assert next(item for item in listed if item["id"] == workspace_id)["team_size"] == 5


def test_project_template_defaults_and_rejects_unknown_value(
    client: TestClient,
    owner_and_workspace: tuple[str, str],
) -> None:
    user_id, workspace_id = owner_and_workspace
    payload = {
        "workspace_id": workspace_id,
        "name": "普通项目",
        "idea": "验证旧请求不传类别仍可创建项目",
        "deadline": (date.today() + timedelta(days=30)).isoformat(),
        "deliverables": "原型",
        "created_by": user_id,
    }
    response = client.post("/api/projects", json=payload)
    assert response.status_code == 201
    assert response.json()["project_template"] == "general"

    invalid = client.post("/api/projects", json={**payload, "project_template": "unknown"})
    assert invalid.status_code == 422
