from datetime import date, datetime
from pydantic import BaseModel

from app.models.enums import TaskPriority, TaskStatus


class TaskCreate(BaseModel):
    project_id: str
    stage_id: str
    title: str
    description: str
    priority: TaskPriority = TaskPriority.P1
    due_date: date
    estimated_hours: float = 0.0
    can_cut: bool = False


class TaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    priority: TaskPriority | None = None
    status: TaskStatus | None = None
    owner_user_id: str | None = None
    can_cut: bool | None = None


class TaskRead(BaseModel):
    id: str
    project_id: str
    stage_id: str
    title: str
    description: str
    priority: TaskPriority
    status: TaskStatus
    owner_user_id: str | None
    backup_owner_user_id: str | None
    due_date: date
    estimated_hours: float
    dependency_ids: dict | list
    acceptance_criteria: dict | list
    can_cut: bool
    assignment_reason: str | None
    created_by_agent: bool
    updated_at: datetime


class TaskStatusUpdateCreate(BaseModel):
    task_id: str
    user_id: str
    status: TaskStatus
    progress_note: str | None = None
    blocker: str | None = None


class TaskStatusUpdateRead(BaseModel):
    id: str
    task_id: str
    user_id: str
    status: TaskStatus
    progress_note: str | None
    blocker: str | None
    available_hours_change: float | None
    created_at: datetime
