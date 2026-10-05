import uuid
from datetime import datetime, timezone

from sqlmodel import SQLModel, Field


class Project(SQLModel, table=True):
    __tablename__ = "projects"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(foreign_key="workspaces.id", index=True)
    name: str
    idea: str
    deadline: str  # ISO date string
    deliverables: str
    project_template: str = Field(default="general")
    status: str = Field(default="draft", index=True)  # "draft" | "active" | "at_risk" | "completed"
    current_stage_id: str | None = Field(default=None, foreign_key="stages.id", index=True)
    direction_card: str | None = Field(default=None)  # JSON string
    created_by: str = Field(foreign_key="users.id", index=True)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
