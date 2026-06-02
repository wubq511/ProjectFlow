import uuid
from datetime import datetime, UTC

from sqlmodel import SQLModel, Field

from app.models.enums import AgentProposalStatus


class AgentProposal(SQLModel, table=True):
    __tablename__ = "agent_proposals"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="projects.id")
    workspace_id: str = Field(foreign_key="workspaces.id")
    proposal_type: str  # "clarify" | "plan" | "breakdown"
    status: AgentProposalStatus = Field(default=AgentProposalStatus.pending)
    agent_event_id: str = Field(foreign_key="agent_events.id")
    payload: str = Field(default="{}")  # JSON string
    confirmed_by: str | None = Field(default=None, foreign_key="users.id")
    confirmed_at: datetime | None = Field(default=None)
    rejection_reason: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
