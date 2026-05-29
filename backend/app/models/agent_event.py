import uuid
from datetime import datetime, UTC

from sqlmodel import SQLModel, Field
from sqlalchemy import Column, Text, JSON, Boolean

from app.models.enums import AgentEventStatus, AgentEventType


class AgentEvent(SQLModel, table=True):
    __tablename__ = "agent_events"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="projects.id")
    workspace_id: str = Field(foreign_key="workspaces.id")
    event_type: AgentEventType
    status: AgentEventStatus = Field(default=AgentEventStatus.success)
    input_snapshot: dict | list = Field(default={}, sa_column=Column(JSON, nullable=False))
    output_snapshot: dict | list = Field(default={}, sa_column=Column(JSON, nullable=False))
    reasoning_summary: str = Field(sa_column=Column(Text, nullable=False))
    user_confirmed: bool = Field(default=False)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
