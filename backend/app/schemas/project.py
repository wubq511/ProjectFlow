from datetime import date, datetime
from pydantic import BaseModel, model_validator

from app.models.enums import ProjectStatus, ProjectTemplate
from app.schemas.common import NonEmptyStr, reject_past_date


class ProjectCreate(BaseModel):
    workspace_id: NonEmptyStr
    name: NonEmptyStr
    idea: NonEmptyStr
    deadline: date
    deliverables: NonEmptyStr
    created_by: NonEmptyStr
    project_template: ProjectTemplate = ProjectTemplate.general

    @model_validator(mode="after")
    def validate_deadline(self) -> "ProjectCreate":
        reject_past_date(self.deadline, "project deadline")
        return self


class ProjectUpdate(BaseModel):
    name: NonEmptyStr | None = None
    idea: NonEmptyStr | None = None
    deadline: date | None = None
    deliverables: NonEmptyStr | None = None
    status: ProjectStatus | None = None
    direction_card: dict | None = None

    @model_validator(mode="after")
    def validate_deadline(self) -> "ProjectUpdate":
        if self.deadline is not None:
            reject_past_date(self.deadline, "project deadline")
        return self


class ProjectRead(BaseModel):
    id: str
    workspace_id: str
    name: str
    idea: str
    deadline: date
    deliverables: str
    project_template: ProjectTemplate
    status: ProjectStatus
    current_stage_id: str | None
    direction_card: dict | None
    created_by: str
    created_at: datetime
    updated_at: datetime
