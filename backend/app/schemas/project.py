from datetime import date, datetime
from pydantic import BaseModel

from app.models.enums import ProjectStatus


class ProjectCreate(BaseModel):
    workspace_id: str
    name: str
    idea: str
    deadline: date
    deliverables: str
    created_by: str


class ProjectUpdate(BaseModel):
    name: str | None = None
    idea: str | None = None
    deadline: date | None = None
    deliverables: str | None = None
    status: ProjectStatus | None = None
    direction_card: dict | None = None


class ProjectRead(BaseModel):
    id: str
    workspace_id: str
    name: str
    idea: str
    deadline: date
    deliverables: str
    status: ProjectStatus
    current_stage_id: str | None
    direction_card: dict | None
    created_by: str
    created_at: datetime
    updated_at: datetime
