from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.project import ProjectCreate, ProjectUpdate, ProjectRead
from app.services.project_service import (
    create_project,
    get_project,
    list_projects_by_workspace,
    update_project,
)

router = APIRouter(tags=["projects"])


@router.post("/projects", response_model=ProjectRead, status_code=201)
def api_create_project(
    data: ProjectCreate,
    session: Session = Depends(get_session),
):
    project = create_project(session, data)
    return project


@router.get("/projects/{project_id}", response_model=ProjectRead)
def api_get_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    project = get_project(session, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/workspaces/{workspace_id}/projects", response_model=list[ProjectRead])
def api_list_projects_by_workspace(
    workspace_id: str,
    session: Session = Depends(get_session),
):
    return list_projects_by_workspace(session, workspace_id)


@router.patch("/projects/{project_id}", response_model=ProjectRead)
def api_update_project(
    project_id: str,
    data: ProjectUpdate,
    session: Session = Depends(get_session),
):
    try:
        return update_project(session, project_id, data)
    except ValueError:
        raise HTTPException(status_code=404, detail="Project not found")
