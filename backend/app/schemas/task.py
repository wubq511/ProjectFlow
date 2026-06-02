from datetime import date, datetime
from pydantic import BaseModel, Field

from app.models.enums import TaskPriority, TaskStatus
from app.schemas.common import NonEmptyStr


class TaskCreate(BaseModel):
    project_id: NonEmptyStr
    stage_id: NonEmptyStr
    title: NonEmptyStr
    description: NonEmptyStr
    priority: TaskPriority = TaskPriority.P1
    due_date: date
    estimated_hours: float = Field(default=0.0, ge=0)
    can_cut: bool = False


class TaskUpdate(BaseModel):
    title: NonEmptyStr | None = None
    description: NonEmptyStr | None = None
    priority: TaskPriority | None = None
    status: TaskStatus | None = None
    owner_user_id: NonEmptyStr | None = None
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
    dependency_ids: list[str]
    acceptance_criteria: list[str]
    can_cut: bool
    assignment_reason: str | None
    created_by_agent: bool
    updated_at: datetime


class TaskStatusUpdateCreate(BaseModel):
    user_id: NonEmptyStr
    status: TaskStatus
    progress_note: NonEmptyStr | None = None
    blocker: NonEmptyStr | None = None
    available_hours_change: float | None = None


class TaskStatusUpdateRead(BaseModel):
    id: str
    task_id: str
    user_id: str
    status: TaskStatus
    progress_note: str | None
    blocker: str | None
    available_hours_change: float | None
    created_at: datetime
