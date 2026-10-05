from datetime import datetime
from pydantic import BaseModel

from app.models.enums import ProjectTemplate, WorkspaceRole
from app.schemas.common import NonEmptyStr


class WorkspaceCreate(BaseModel):
    name: NonEmptyStr
    description: str | None = None
    team_size: int | None = None
    project_template: ProjectTemplate = ProjectTemplate.general


class WorkspaceRead(BaseModel):
    id: str
    name: str
    owner_user_id: str
    description: str | None
    team_size: int | None
    project_template: ProjectTemplate
    created_at: datetime
    updated_at: datetime


class WorkspaceMembershipRead(BaseModel):
    id: str
    workspace_id: str
    user_id: str
    role: WorkspaceRole
    joined_at: datetime


class AddMemberRequest(BaseModel):
    user_id: str
    role: WorkspaceRole = WorkspaceRole.member
