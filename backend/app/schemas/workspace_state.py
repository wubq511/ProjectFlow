from datetime import date

from pydantic import BaseModel, Field


class MemberState(BaseModel):
    user_id: str
    display_name: str
    skills: list
    available_hours_per_week: float
    role_preference: str
    interests: str
    constraints: str


class StageState(BaseModel):
    id: str
    name: str
    goal: str
    start_date: date | None = None
    end_date: date | None = None
    deliverable: str = ""
    done_criteria: list[str] = Field(default_factory=list)
    status: str
    order_index: int


class TaskState(BaseModel):
    id: str
    stage_id: str = ""
    title: str
    description: str = ""
    status: str
    priority: str
    owner_user_id: str | None
    backup_owner_user_id: str | None = None
    due_date: date | None = None
    estimated_hours: float = 0.0
    dependency_ids: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    can_cut: bool
    assignment_reason: str | None = None


class CheckInCycleState(BaseModel):
    id: str
    stage_id: str
    cadence_days: int
    next_due_date: str
    status: str
    name: str = ""  # 供 Agent 上下文使用，如 "签到周期（2025-07-01 开始，每2天）"


class CheckInResponseState(BaseModel):
    id: str
    cycle_id: str
    user_id: str
    task_id: str | None = None
    what_done: str
    blocker: str | None = None
    available_hours_next_cycle: float | None = None
    mood_or_confidence: str | None = None


class AssignmentProposalState(BaseModel):
    id: str
    stage_id: str
    task_id: str
    recommended_owner_user_id: str
    backup_owner_user_id: str | None = None
    status: str


class AssignmentResponseState(BaseModel):
    id: str
    proposal_id: str
    user_id: str
    response: str
    preferred_task_id: str | None = None
    reason: str | None = None


class AssignmentNegotiationState(BaseModel):
    id: str
    stage_id: str
    from_user_id: str
    desired_task_id: str
    current_owner_user_id: str | None = None
    status: str


class ResourceState(BaseModel):
    id: str
    type: str  # text_note | file_stub | link
    title: str
    content_text: str | None = None
    file_name: str | None = None
    url: str | None = None
    created_at: str


class ProjectState(BaseModel):
    id: str
    name: str
    idea: str
    deadline: date
    deliverables: str = ""
    direction_card: dict | None = None
    status: str
    current_stage_id: str | None
    stages: list[StageState]
    tasks: list[TaskState]
    checkin_cycles: list[CheckInCycleState] = Field(default_factory=list)
    checkin_responses: list[CheckInResponseState] = Field(default_factory=list)
    assignment_proposals: list[AssignmentProposalState] = Field(default_factory=list)
    assignment_responses: list[AssignmentResponseState] = Field(default_factory=list)
    assignment_negotiations: list[AssignmentNegotiationState] = Field(default_factory=list)
    resources: list[ResourceState] = Field(default_factory=list)


class WorkspaceStateResponse(BaseModel):
    workspace_id: str
    workspace_name: str
    members: list[MemberState]
    project: ProjectState | None
    current_date: str = ""
    current_datetime: str = ""
    timezone: str = ""
