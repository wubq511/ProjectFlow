"""Tests for project/workspace state read purity and explicit repair."""

import json
from collections.abc import Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.database import get_session
from app.models import Project, Stage, Task, User, Workspace, WorkspaceMembership
from app.services.project_state_service import get_project_state, repair_project_state
from app.services.workspace_state_service import get_workspace_state


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(eng)
    yield eng


@pytest.fixture
def session(engine) -> Iterator[Session]:
    with Session(engine) as test_session:
        yield test_session


@pytest.fixture
def stateful_client(engine) -> Iterator[TestClient]:
    from app.main import app

    def _override_session():
        with Session(engine) as test_session:
            yield test_session

    @asynccontextmanager
    async def _noop_lifespan(app: FastAPI):
        yield

    app.router.lifespan_context = _noop_lifespan
    app.dependency_overrides[get_session] = _override_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _seed_stale_project(
    session: Session,
    *,
    second_stage_task_status: str = "not_started",
) -> dict[str, str]:
    user = User(id="user-1", display_name="测试成员")
    workspace = Workspace(id="workspace-1", name="测试工作区", owner_user_id=user.id)
    membership = WorkspaceMembership(workspace_id=workspace.id, user_id=user.id)
    project = Project(
        id="project-1",
        workspace_id=workspace.id,
        name="测试项目",
        idea="验证读路径纯净",
        deadline="2026-07-31",
        deliverables="可运行修复流程",
        status="active",
        current_stage_id="stage-1",
        created_by=user.id,
    )
    active_stage = Stage(
        id="stage-1",
        project_id=project.id,
        name="阶段一",
        goal="完成第一阶段",
        start_date="2026-07-01",
        end_date="2026-07-07",
        deliverable="阶段一交付物",
        status="active",
        order_index=0,
    )
    pending_stage = Stage(
        id="stage-2",
        project_id=project.id,
        name="阶段二",
        goal="完成第二阶段",
        start_date="2026-07-08",
        end_date="2026-07-14",
        deliverable="阶段二交付物",
        status="pending",
        order_index=1,
    )
    first_task = Task(
        id="task-1",
        project_id=project.id,
        stage_id=active_stage.id,
        title="阶段一任务",
        status="done",
        due_date="2026-07-05",
    )
    second_task = Task(
        id="task-2",
        project_id=project.id,
        stage_id=pending_stage.id,
        title="阶段二任务",
        status=second_stage_task_status,
        due_date="2026-07-12",
    )
    session.add(user)
    session.add(workspace)
    session.add(membership)
    session.add(project)
    session.add(active_stage)
    session.add(pending_stage)
    session.add(first_task)
    session.add(second_task)
    session.commit()
    return {
        "workspace_id": workspace.id,
        "project_id": project.id,
        "active_stage_id": active_stage.id,
        "pending_stage_id": pending_stage.id,
    }


def test_project_state_endpoint_returns_frontend_payload(client: TestClient):
    client.post("/api/seed/demo")

    response = client.get("/api/projects/demo-project-001/state")

    assert response.status_code == 200
    state = response.json()
    assert set(state) == {
        "workspace",
        "project",
        "resources",
        "members",
        "memberships",
        "member_profiles",
        "projects",
        "stages",
        "tasks",
        "agent_proposals",
        "assignment_proposals",
        "assignment_responses",
        "assignment_negotiations",
        "checkins",
        "risks",
        "action_cards",
        "timeline",
    }
    assert state["workspace"]["id"] == "demo-workspace-001"
    assert state["project"]["id"] == "demo-project-001"
    assert len(state["members"]) == 6
    assert len(state["memberships"]) == 6
    assert len(state["member_profiles"]) == 6
    assert len(state["projects"]) == 1
    assert len(state["stages"]) == 4
    assert len(state["tasks"]) == 10
    assert state["tasks"][0]["dependency_ids"] == []
    assert isinstance(state["risks"][0]["evidence"], list)
    assert state["timeline"]


def test_project_state_endpoint_404_for_missing_project(client: TestClient):
    response = client.get("/api/projects/missing-project/state")

    assert response.status_code == 404


def test_get_project_state_does_not_repair_stale_progress(session: Session):
    ids = _seed_stale_project(session)

    state = get_project_state(session, ids["project_id"])

    assert state is not None
    assert state.project.current_stage_id == ids["active_stage_id"]
    session.expire_all()
    project = session.get(Project, ids["project_id"])
    active_stage = session.get(Stage, ids["active_stage_id"])
    pending_stage = session.get(Stage, ids["pending_stage_id"])
    assert project is not None
    assert active_stage is not None
    assert pending_stage is not None
    assert project.status == "active"
    assert project.current_stage_id == ids["active_stage_id"]
    assert active_stage.status == "active"
    assert pending_stage.status == "pending"


def test_get_workspace_state_does_not_repair_stale_progress(session: Session):
    ids = _seed_stale_project(session)

    state = get_workspace_state(
        session,
        ids["workspace_id"],
        project_id=ids["project_id"],
    )

    assert state is not None
    assert state.project is not None
    assert state.project.current_stage_id == ids["active_stage_id"]
    session.expire_all()
    project = session.get(Project, ids["project_id"])
    active_stage = session.get(Stage, ids["active_stage_id"])
    pending_stage = session.get(Stage, ids["pending_stage_id"])
    assert project is not None
    assert active_stage is not None
    assert pending_stage is not None
    assert project.status == "active"
    assert project.current_stage_id == ids["active_stage_id"]
    assert active_stage.status == "active"
    assert pending_stage.status == "pending"


def test_repair_project_state_explicitly_advances_stale_stage(session: Session):
    ids = _seed_stale_project(session)

    repair_result = repair_project_state(session, ids["project_id"])

    assert repair_result is not None
    assert repair_result.changed is True
    assert repair_result.repaired_stage_ids == [ids["active_stage_id"]]
    assert repair_result.current_stage_id == ids["pending_stage_id"]
    assert repair_result.project_status == "active"
    session.expire_all()
    project = session.get(Project, ids["project_id"])
    active_stage = session.get(Stage, ids["active_stage_id"])
    pending_stage = session.get(Stage, ids["pending_stage_id"])
    assert project is not None
    assert active_stage is not None
    assert pending_stage is not None
    assert project.current_stage_id == ids["pending_stage_id"]
    assert active_stage.status == "completed"
    assert pending_stage.status == "active"


def test_project_state_repair_endpoint_repairs_cascaded_stale_progress(
    stateful_client: TestClient,
    engine,
):
    with Session(engine) as session:
        ids = _seed_stale_project(session, second_stage_task_status="done")

    response = stateful_client.post(f"/api/projects/{ids['project_id']}/state-repair")

    assert response.status_code == 200
    payload = response.json()
    assert payload["changed"] is True
    assert payload["repaired_stage_ids"] == [ids["active_stage_id"], ids["pending_stage_id"]]
    assert payload["current_stage_id"] is None
    assert payload["project_status"] == "completed"

    with Session(engine) as session:
        project = session.get(Project, ids["project_id"])
        active_stage = session.get(Stage, ids["active_stage_id"])
        pending_stage = session.get(Stage, ids["pending_stage_id"])
        assert project is not None
        assert active_stage is not None
        assert pending_stage is not None
        assert project.status == "completed"
        assert project.current_stage_id is None
        assert active_stage.status == "completed"
        assert pending_stage.status == "completed"
