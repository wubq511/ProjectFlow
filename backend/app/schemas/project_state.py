from pydantic import BaseModel

from app.schemas.action_card import ActionCardRead
from app.schemas.agent_event import AgentEventRead
from app.schemas.agent_proposal import AgentProposalRead
from app.schemas.assignment import (
    AssignmentNegotiationRead,
    AssignmentProposalRead,
    AssignmentResponseRead,
)
from app.schemas.checkin import CheckInCycleRead
from app.schemas.member_profile import MemberProfileRead
from app.schemas.project import ProjectRead
from app.schemas.resource import ResourceRead
from app.schemas.risk import RiskRead
from app.schemas.stage import StageRead
from app.schemas.task import TaskRead
from app.schemas.user import UserRead
from app.schemas.workspace import WorkspaceMembershipRead, WorkspaceRead


class ProjectStateRead(BaseModel):
    workspace: WorkspaceRead
    project: ProjectRead
    resources: list[ResourceRead]
    members: list[UserRead]
    memberships: list[WorkspaceMembershipRead]
    member_profiles: list[MemberProfileRead]
    projects: list[ProjectRead]
    stages: list[StageRead]
    tasks: list[TaskRead]
    agent_proposals: list[AgentProposalRead]
    assignment_proposals: list[AssignmentProposalRead]
    assignment_responses: list[AssignmentResponseRead]
    assignment_negotiations: list[AssignmentNegotiationRead]
    checkins: list[CheckInCycleRead]
    risks: list[RiskRead]
    action_cards: list[ActionCardRead]
    timeline: list[AgentEventRead]


class ProjectStateRepairRead(BaseModel):
    project_id: str
    changed: bool
    repaired_stage_ids: list[str]
    current_stage_id: str | None
    project_status: str
    message: str
