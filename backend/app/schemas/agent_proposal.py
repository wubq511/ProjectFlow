from datetime import datetime
from typing import Any

from pydantic import BaseModel

from app.models.enums import AgentProposalStatus


class AgentProposalRead(BaseModel):
    id: str
    project_id: str
    workspace_id: str
    proposal_type: str
    status: AgentProposalStatus
    agent_event_id: str
    payload: dict[str, Any] | list[Any]
    confirmed_by: str | None
    confirmed_at: datetime | None
    rejection_reason: str | None = None
    created_at: datetime


class AgentProposalConfirm(BaseModel):
    confirmed_by: str


class AgentProposalReject(BaseModel):
    reason: str | None = None
