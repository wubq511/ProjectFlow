import json

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.models.task import Task
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


def _task_to_read(task: Task) -> TaskRead:
    """Convert a Task model to its read schema, deserializing JSON fields."""
    from datetime import date as date_type
    return TaskRead(
        id=task.id,
        project_id=task.project_id,
        stage_id=task.stage_id,
        title=task.title,
        description=task.description,
        priority=task.priority,
        status=task.status,
        owner_user_id=task.owner_user_id,
        backup_owner_user_id=task.backup_owner_user_id,
        due_date=task.due_date if isinstance(task.due_date, date_type) else task.due_date,
        estimated_hours=task.estimated_hours,
        dependency_ids=json.loads(task.dependency_ids) if task.dependency_ids else [],
        acceptance_criteria=json.loads(task.acceptance_criteria) if task.acceptance_criteria else [],
        can_cut=task.can_cut,
        assignment_reason=task.assignment_reason,
        created_by_agent=task.created_by_agent,
        updated_at=task.updated_at,
    )


@router.post("/tasks", response_model=TaskRead, status_code=201)
def api_create_task(
    data: TaskCreate,
    session: Session = Depends(get_session),
):
    task = create_task(session, data)
    return _task_to_read(task)


@router.get("/tasks/{task_id}", response_model=TaskRead)
def api_get_task(
    task_id: str,
    session: Session = Depends(get_session),
):
    task = get_task(session, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return _task_to_read(task)


@router.get("/stages/{stage_id}/tasks", response_model=list[TaskRead])
def api_list_tasks_by_stage(
    stage_id: str,
    session: Session = Depends(get_session),
):
    tasks = list_tasks_by_stage(session, stage_id)
    return [_task_to_read(t) for t in tasks]


@router.get("/projects/{project_id}/tasks", response_model=list[TaskRead])
def api_list_tasks_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    tasks = list_tasks_by_project(session, project_id)
    return [_task_to_read(t) for t in tasks]


@router.patch("/tasks/{task_id}", response_model=TaskRead)
def api_update_task(
    task_id: str,
    data: TaskUpdate,
    session: Session = Depends(get_session),
):
    try:
        task = update_task(session, task_id, data)
        return _task_to_read(task)
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
    return create_status_update(session, task_id, data)
