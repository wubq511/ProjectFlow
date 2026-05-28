from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.task import (
    TaskCreate,
    TaskUpdate,
    TaskRead,
    TaskStatusUpdateCreate,
    TaskStatusUpdateRead,
)
from app.services.task_service import (
    create_task,
    get_task,
    list_tasks_by_stage,
    list_tasks_by_project,
    update_task,
    create_status_update,
)

router = APIRouter(tags=["tasks"])


@router.post("/tasks", response_model=TaskRead, status_code=201)
def api_create_task(
    data: TaskCreate,
    session: Session = Depends(get_session),
):
    return create_task(session, data)


@router.get("/tasks/{task_id}", response_model=TaskRead)
def api_get_task(
    task_id: str,
    session: Session = Depends(get_session),
):
    task = get_task(session, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/stages/{stage_id}/tasks", response_model=list[TaskRead])
def api_list_tasks_by_stage(
    stage_id: str,
    session: Session = Depends(get_session),
):
    return list_tasks_by_stage(session, stage_id)


@router.get("/projects/{project_id}/tasks", response_model=list[TaskRead])
def api_list_tasks_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_tasks_by_project(session, project_id)


@router.patch("/tasks/{task_id}", response_model=TaskRead)
def api_update_task(
    task_id: str,
    data: TaskUpdate,
    session: Session = Depends(get_session),
):
    try:
        return update_task(session, task_id, data)
    except ValueError:
        raise HTTPException(status_code=404, detail="Task not found")


@router.post(
    "/tasks/{task_id}/status-updates",
    response_model=TaskStatusUpdateRead,
    status_code=201,
)
def api_create_status_update(
    task_id: str,
    data: TaskStatusUpdateCreate,
    session: Session = Depends(get_session),
):
    data.task_id = task_id
    return create_status_update(session, data)
