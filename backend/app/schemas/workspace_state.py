from datetime import date, datetime
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


class CheckInResponseState(BaseModel):
    id: str
    cycle_id: str
    user_id: str
    task_id: str | None = None
    what_done: str
    blocker: str | None = None
    available_hours_next_cycle: float | None = None
    mood_or_confidence: str | None = None


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


class WorkspaceStateResponse(BaseModel):
    workspace_id: str
    workspace_name: str
    members: list[MemberState]
    project: ProjectState | None
