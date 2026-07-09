from datetime import datetime

from pydantic import BaseModel

from app.models.enums import (
    AssignmentProposalStatus,
    AssignmentResponseType,
    NegotiationStatus,
)
from app.schemas.common import NonEmptyStr


class AssignmentProposalCreate(BaseModel):
    project_id: NonEmptyStr
    stage_id: NonEmptyStr
    task_id: NonEmptyStr
    recommended_owner_user_id: NonEmptyStr
    backup_owner_user_id: NonEmptyStr | None = None
    reason: NonEmptyStr
    skill_match: NonEmptyStr | None = None
    availability_match: NonEmptyStr | None = None
    preference_match: NonEmptyStr | None = None
    constraint_respected: NonEmptyStr | None = None
    risk_note: NonEmptyStr | None = None
    created_by_agent: bool = False


class AssignmentProposalRead(BaseModel):
    id: str
    project_id: str
    stage_id: str
    task_id: str
    recommended_owner_user_id: str
    backup_owner_user_id: str | None
    reason: str
    skill_match: str | None
    availability_match: str | None
    preference_match: str | None
    constraint_respected: str | None
    risk_note: str | None
    status: AssignmentProposalStatus
    created_by_agent: bool
    created_at: datetime


class AssignmentResponseCreate(BaseModel):
    user_id: NonEmptyStr
    response: AssignmentResponseType
    preferred_task_id: NonEmptyStr | None = None
    reason: NonEmptyStr | None = None


class AssignmentResponseRead(BaseModel):
    id: str
    proposal_id: str
    user_id: str
    response: AssignmentResponseType
    preferred_task_id: str | None
    reason: str | None
    created_at: datetime


class AssignmentNegotiationCreate(BaseModel):
    project_id: NonEmptyStr
    stage_id: NonEmptyStr
    from_user_id: NonEmptyStr
    desired_task_id: NonEmptyStr
    current_owner_user_id: NonEmptyStr | None = None
    agent_message: NonEmptyStr


class AssignmentNegotiationFromProposalCreate(BaseModel):
    """Request schema for creating a negotiation directly from a proposal rejection.

    The backend uses the proposal context to generate a user-readable agent_message
    with member display names and task titles instead of raw IDs.
    """
    from_user_id: NonEmptyStr
    desired_task_id: NonEmptyStr


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


class AssignmentNegotiationResolve(BaseModel):
    resolution: str  # "accepted" | "declined"
