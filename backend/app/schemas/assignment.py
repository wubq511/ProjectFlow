from datetime import datetime

from pydantic import BaseModel

from app.models.enums import (
    AssignmentProposalStatus,
    AssignmentResponseType,
    NegotiationStatus,
)


class AssignmentProposalCreate(BaseModel):
    project_id: str
    stage_id: str
    task_id: str
    recommended_owner_user_id: str
    backup_owner_user_id: str | None = None
    reason: str
    risk_note: str | None = None
    created_by_agent: bool = False


class AssignmentProposalRead(BaseModel):
    id: str
    project_id: str
    stage_id: str
    task_id: str
    recommended_owner_user_id: str
    backup_owner_user_id: str | None
    reason: str
    risk_note: str | None
    status: AssignmentProposalStatus
    created_by_agent: bool
    created_at: datetime


class AssignmentResponseCreate(BaseModel):
    user_id: str
    response: AssignmentResponseType
    preferred_task_id: str | None = None
    reason: str | None = None


class AssignmentResponseRead(BaseModel):
    id: str
    proposal_id: str
    user_id: str
    response: AssignmentResponseType
    preferred_task_id: str | None
    reason: str | None
    created_at: datetime


class AssignmentNegotiationCreate(BaseModel):
    project_id: str
    stage_id: str
    from_user_id: str
    desired_task_id: str
    current_owner_user_id: str | None = None
    agent_message: str


class AssignmentNegotiationRead(BaseModel):
    id: str
    project_id: str
    stage_id: str
    from_user_id: str
    desired_task_id: str
    current_owner_user_id: str | None
    status: NegotiationStatus
    agent_message: str
    created_at: datetime
