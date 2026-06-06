import uuid
from datetime import datetime, timezone

from sqlmodel import SQLModel, Field


class Workspace(SQLModel, table=True):
    __tablename__ = "workspaces"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    name: str
    owner_user_id: str = Field(foreign_key="users.id")
    description: str | None = Field(default=None)
    team_size: int | None = Field(default=None)
    use_case: str | None = Field(default=None)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class WorkspaceMembership(SQLModel, table=True):
    __tablename__ = "workspace_memberships"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    workspace_id: str = Field(foreign_key="workspaces.id")
    user_id: str = Field(foreign_key="users.id")
    role: str = Field(default="member")  # "owner" | "member"
    joined_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
