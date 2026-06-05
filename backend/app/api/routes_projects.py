from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.models.project import Project
from app.schemas.project import ProjectCreate, ProjectUpdate, ProjectRead
from app.schemas.project_state import ProjectStateRead
from app.services.project_service import (
    create_project,
    delete_project,
    get_project,
    list_projects_by_workspace,
    normalize_direction_card,
    update_project,
)
from app.services.project_state_service import get_project_state

router = APIRouter(tags=["projects"])


def _project_to_read(project: Project) -> ProjectRead:
    return ProjectRead(
        id=project.id,
        workspace_id=project.workspace_id,
        name=project.name,
        idea=project.idea,
        deadline=project.deadline,
        deliverables=project.deliverables,
        status=project.status,
        current_stage_id=project.current_stage_id,
        direction_card=normalize_direction_card(project.direction_card),
        created_by=project.created_by,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.post("/projects", response_model=ProjectRead, status_code=201)
def api_create_project(
    data: ProjectCreate,
    session: Session = Depends(get_session),
):
    project = create_project(session, data)
    return _project_to_read(project)


@router.get("/projects/{project_id}", response_model=ProjectRead)
def api_get_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    project = get_project(session, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_to_read(project)


@router.get("/projects/{project_id}/state", response_model=ProjectStateRead)
def api_get_project_state(
    project_id: str,
    session: Session = Depends(get_session),
):
    state = get_project_state(session, project_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return state


@router.get("/workspaces/{workspace_id}/projects", response_model=list[ProjectRead])
def api_list_projects_by_workspace(
    workspace_id: str,
    session: Session = Depends(get_session),
):
    return [_project_to_read(project) for project in list_projects_by_workspace(session, workspace_id)]


@router.patch("/projects/{project_id}", response_model=ProjectRead)
def api_update_project(
    project_id: str,
    data: ProjectUpdate,
    session: Session = Depends(get_session),
):
    try:
        return _project_to_read(update_project(session, project_id, data))
    except ValueError:
        raise HTTPException(status_code=404, detail="Project not found")


@router.delete("/projects/{project_id}", status_code=204)
def api_delete_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    try:
        delete_project(session, project_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Project not found")
