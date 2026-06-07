import re
from datetime import date
from typing import Any

from pydantic import BaseModel, Field, ValidationError, model_validator

from app.models.enums import (
    ActionCardType,
    AgentEventType,
    RiskSeverity,
    RiskType,
    TaskPriority,
    TaskStatus,
)
from app.agent.modules.common import (
    SKILL_NAME_CN_MAP,
    active_stage_id as resolve_active_stage_id,
    assignable_tasks,
    blocked_assignment_task_ids,
)
from app.schemas.workspace_state import WorkspaceStateResponse


class AgentOutputValidationError(ValueError):
    """Raised when an agent payload cannot be trusted as structured output."""


class AgentOutputBase(BaseModel):
    reason: str = Field(min_length=1)
    requires_confirmation: bool = False


class DirectionCardOutput(AgentOutputBase):
    problem: str = Field(min_length=1, description="The core problem this project solves")
    users: str = Field(min_length=1, description="Who the project serves")
    value: str = Field(min_length=1, description="What value the project delivers")
    deliverables: list[str] = Field(min_length=1, description="Concrete outputs the project must produce")
    boundaries: list[str] = Field(default_factory=list, description="Explicit scope boundaries — what is out of scope")
    risks: list[str] = Field(default_factory=list, description="Known risks grounded in project context")
    suggested_questions: list[str] = Field(default_factory=list, description="High-value clarification questions only")

    # Optional enrichment fields; defaults keep older persisted payloads valid.
    source_summary: str | None = Field(default=None, description="Summary of where the direction came from (project idea, resources, members)")
    assumptions: list[str] = Field(default_factory=list, description="Key assumptions made during clarification")
    unknowns: list[str] = Field(default_factory=list, description="Important unknowns that could affect the plan")
    mvp_boundary: dict | None = Field(default=None, description="MVP scope boundary with must_have, defer, out_of_scope")
    decision_points: list[str] = Field(default_factory=list, description="Key decisions the team needs to make")
    requires_confirmation: bool = True

    @model_validator(mode="after")
    def require_confirmation(self) -> "DirectionCardOutput":
        if not self.requires_confirmation:
            raise ValueError("direction card output requires confirmation")
        return self


class StagePlanItem(BaseModel):
    name: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    start_date: date
    end_date: date
    deliverable: str = Field(min_length=1)
    done_criteria: list[str] = Field(default_factory=list)
    order_index: int = Field(ge=0)
    reason: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_dates(self) -> "StagePlanItem":
        if self.end_date < self.start_date:
            raise ValueError("stage end_date must be on or after start_date")
        return self


class StagePlanOutput(AgentOutputBase):
    stages: list[StagePlanItem] = Field(min_length=1)
    requires_confirmation: bool = True

    @model_validator(mode="after")
    def require_confirmation(self) -> "StagePlanOutput":
        if not self.requires_confirmation:
            raise ValueError("stage plan output requires confirmation")
        return self


class TaskBreakdownItem(BaseModel):
    id: str = Field(default="", description="Task identifier for dependency references, e.g. 'task-1', 'task-2'. Auto-generated if empty.")
    stage_id: str | None = None
    title: str = Field(min_length=1)
    description: str = Field(min_length=1)
    priority: TaskPriority
    due_date: date
    estimated_hours: float = Field(ge=0)
    dependency_ids: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    can_cut: bool = False
    order_index: int = Field(default=0, ge=0, description="Sort order within the stage")
    reason: str = Field(min_length=1)


class TaskBreakdownOutput(AgentOutputBase):
    tasks: list[TaskBreakdownItem] = Field(min_length=1)
    requires_confirmation: bool = True

    @model_validator(mode="after")
    def require_confirmation(self) -> "TaskBreakdownOutput":
        if not self.requires_confirmation:
            raise ValueError("task breakdown output requires confirmation")
        return self

    @model_validator(mode="after")
    def auto_generate_task_ids(self) -> "TaskBreakdownOutput":
        for idx, task in enumerate(self.tasks):
            if not task.id:
                task.id = f"task-{idx + 1}"
        return self


class AssignmentRecommendationItem(BaseModel):
    task_id: str = Field(min_length=1)
    recommended_owner_user_id: str = Field(min_length=1)
    backup_owner_user_id: str | None = None
    reason: str = Field(min_length=1)
    skill_match: str | None = Field(default=None, description="Which member skill matches the task domain")
    availability_match: str | None = Field(default=None, description="How member available_hours fits the task estimated_hours")
    preference_match: str | None = Field(default=None, description="How member role_preference/interests align with the task")
    constraint_respected: str | None = Field(default=None, description="Which member constraints were checked and not violated")
    risk_note: str | None = None


class AssignmentRecommendationOutput(AgentOutputBase):
    assignments: list[AssignmentRecommendationItem] = Field(default_factory=list)
    requires_confirmation: bool = True

    @model_validator(mode="after")
    def require_confirmation(self) -> "AssignmentRecommendationOutput":
        if not self.requires_confirmation:
            raise ValueError("assignment recommendations require confirmation")
        return self


class AssignmentNegotiationOutput(AgentOutputBase):
    from_user_id: str = Field(min_length=1)
    desired_task_id: str = Field(min_length=1)
    current_owner_user_id: str | None = None
    message: str = Field(min_length=1)
    options: list[str] = Field(min_length=1)
    requires_confirmation: bool = True

    @model_validator(mode="after")
    def require_confirmation(self) -> "AssignmentNegotiationOutput":
        if not self.requires_confirmation:
            raise ValueError("assignment negotiation requires confirmation")
        return self


class ActionCardProposal(BaseModel):
    type: ActionCardType
    title: str = Field(min_length=1)
    content: str = Field(default="", description="Card body text. If empty, title serves as the primary message.")
    reason: str = Field(min_length=1)
    goal: str | None = Field(default=None, description="What this card achieves for the project")
    start_suggestion: str | None = Field(default=None, description="Concrete first step to take")
    completion_standard: str | None = Field(default=None, description="How to know the action is done")
    user_id: str | None = None
    task_id: str | None = None
    stage_id: str | None = None
    due_date: date | None = None


class ActivePushOutput(AgentOutputBase):
    action_cards: list[ActionCardProposal] = Field(default_factory=list)


class CheckInTaskUpdate(BaseModel):
    task_id: str = Field(min_length=1)
    user_id: str = Field(min_length=1)
    status: TaskStatus
    progress_note: str | None = None
    blocker: str | None = None
    available_hours_change: float | None = None


class RiskProposal(BaseModel):
    type: RiskType
    severity: RiskSeverity
    title: str = Field(min_length=1)
    description: str = Field(min_length=1)
    evidence: list[str | dict[str, Any]] = Field(min_length=1)
    recommendation: str = Field(min_length=1)
    stage_id: str | None = None
    task_id: str | None = None


class CheckInAnalysisOutput(AgentOutputBase):
    summary: str = Field(min_length=1)
    task_updates: list[CheckInTaskUpdate] = Field(default_factory=list)
    risks: list[RiskProposal] = Field(default_factory=list)


class RiskAnalysisOutput(AgentOutputBase):
    risks: list[RiskProposal] = Field(default_factory=list)

    @model_validator(mode="after")
    def high_risk_requires_confirmation(self) -> "RiskAnalysisOutput":
        has_high_risk = any(risk.severity == RiskSeverity.high for risk in self.risks)
        if has_high_risk and not self.requires_confirmation:
            raise ValueError("high severity risks require confirmation")
        return self


class StageAdjustment(BaseModel):
    stage_id: str = Field(min_length=1)
    new_start_date: date | None = None
    new_end_date: date | None = None
    reason: str = Field(min_length=1)


class TaskChange(BaseModel):
    task_id: str = Field(min_length=1)
    title: str | None = None
    status: TaskStatus | None = None
    owner_user_id: str | None = None
    due_date: date | None = None
    can_cut: bool | None = None
    reason: str = Field(min_length=1)


class ReplanOutput(AgentOutputBase):
    before: dict[str, Any] | list | str
    after: dict[str, Any] | list | str
    impact: str = Field(min_length=1)
    stage_adjustments: list[StageAdjustment] = Field(default_factory=list)
    task_changes: list[TaskChange] = Field(default_factory=list)
    action_cards: list[ActionCardProposal] = Field(default_factory=list)
    requires_confirmation: bool = True

    @model_validator(mode="after")
    def require_confirmation(self) -> "ReplanOutput":
        if not self.requires_confirmation:
            raise ValueError("replan output requires confirmation")
        return self


OUTPUT_SCHEMA_BY_EVENT_TYPE: dict[AgentEventType, type[AgentOutputBase]] = {
    AgentEventType.clarify: DirectionCardOutput,
    AgentEventType.plan: StagePlanOutput,
    AgentEventType.breakdown: TaskBreakdownOutput,
    AgentEventType.assign: AssignmentRecommendationOutput,
    AgentEventType.negotiate: AssignmentNegotiationOutput,
    AgentEventType.push: ActivePushOutput,
    AgentEventType.checkin: CheckInAnalysisOutput,
    AgentEventType.risk: RiskAnalysisOutput,
    AgentEventType.replan: ReplanOutput,
}


def validate_agent_output(
    event_type: AgentEventType | str,
    payload: dict[str, Any],
    *,
    workspace_state: WorkspaceStateResponse | None = None,
) -> AgentOutputBase:
    try:
        normalized_event_type = AgentEventType(event_type)
        schema = OUTPUT_SCHEMA_BY_EVENT_TYPE[normalized_event_type]
        output = schema.model_validate(payload)
        if workspace_state is not None:
            _validate_references(output, workspace_state)
            _normalize_user_facing_text(output)
        return output
    except (KeyError, ValueError, ValidationError) as exc:
        raise AgentOutputValidationError(str(exc)) from exc


def _validate_references(output: AgentOutputBase, workspace_state: WorkspaceStateResponse) -> None:
    member_ids = {member.user_id for member in workspace_state.members}
    stage_ids = {stage.id for stage in workspace_state.project.stages} if workspace_state.project else set()
    task_ids = {task.id for task in workspace_state.project.tasks} if workspace_state.project else set()

    errors: list[str] = []

    def check(value: str | None, valid_ids: set[str], label: str) -> None:
        if value and value not in valid_ids:
            errors.append(f"{label} references unknown id: {value}")

    if isinstance(output, TaskBreakdownOutput):
        # Include IDs of tasks being created in this output (for self-referencing deps)
        new_task_ids = {t.id for t in output.tasks if t.id}
        all_task_ids = task_ids | new_task_ids
        for task in output.tasks:
            # Only check stage_id when stages actually exist; tasks created
            # before stages are confirmed can reference stage_id=None.
            if stage_ids:
                check(task.stage_id, stage_ids, "stage_id")
            for dependency_id in task.dependency_ids:
                check(dependency_id, all_task_ids, "dependency_ids")

    if isinstance(output, AssignmentRecommendationOutput):
        seen_task_ids: set[str] = set()
        for assignment in output.assignments:
            check(assignment.task_id, task_ids, "task_id")
            check(assignment.recommended_owner_user_id, member_ids, "recommended_owner_user_id")
            check(assignment.backup_owner_user_id, member_ids, "backup_owner_user_id")

            # No duplicate task_ids
            if assignment.task_id in seen_task_ids:
                errors.append(f"duplicate task_id in assignments: {assignment.task_id}")
            seen_task_ids.add(assignment.task_id)

            # backup cannot equal owner
            if assignment.backup_owner_user_id and assignment.backup_owner_user_id == assignment.recommended_owner_user_id:
                errors.append(f"backup_owner_user_id must differ from recommended_owner_user_id for task {assignment.task_id}")

        # Semantic checks against workspace_state
        if workspace_state.project:
            task_by_id = {t.id: t for t in workspace_state.project.tasks}
            resolved_stage_id = resolve_active_stage_id(workspace_state)
            blocked_task_ids = blocked_assignment_task_ids(workspace_state)

            for assignment in output.assignments:
                task = task_by_id.get(assignment.task_id)
                if task is None:
                    continue

                # Must belong to active stage
                if resolved_stage_id and task.stage_id != resolved_stage_id:
                    errors.append(f"task {assignment.task_id} is not in active stage {resolved_stage_id}")

                # Must not have owner_user_id
                if task.owner_user_id:
                    errors.append(f"task {assignment.task_id} already has owner {task.owner_user_id}")

                # Must not be done
                if task.status == "done":
                    errors.append(f"task {assignment.task_id} is already done")

                # Must not already have a non-rejected proposal
                if assignment.task_id in blocked_task_ids:
                    errors.append(f"task {assignment.task_id} already has a proposal in status finalized/owner_confirmed/proposed/negotiating")

            # Must cover all eligible tasks (unless zero eligible or no members)
            eligible = assignable_tasks(workspace_state)
            if eligible:
                proposed_task_ids = {a.task_id for a in output.assignments}
                missing = [t.id for t in eligible if t.id not in proposed_task_ids]
                if missing:
                    errors.append(f"missing assignment for eligible tasks: {missing}")

    if isinstance(output, AssignmentNegotiationOutput):
        check(output.from_user_id, member_ids, "from_user_id")
        check(output.desired_task_id, task_ids, "desired_task_id")
        check(output.current_owner_user_id, member_ids, "current_owner_user_id")

    if isinstance(output, ActivePushOutput):
        _validate_action_card_references(output.action_cards, member_ids, stage_ids, task_ids, errors)

    if isinstance(output, CheckInAnalysisOutput):
        for update in output.task_updates:
            check(update.task_id, task_ids, "task_id")
            check(update.user_id, member_ids, "user_id")
        _validate_risk_references(output.risks, stage_ids, task_ids, errors)

    if isinstance(output, RiskAnalysisOutput):
        _validate_risk_references(output.risks, stage_ids, task_ids, errors)

    if isinstance(output, ReplanOutput):
        for adjustment in output.stage_adjustments:
            check(adjustment.stage_id, stage_ids, "stage_id")
        for change in output.task_changes:
            check(change.task_id, task_ids, "task_id")
            check(change.owner_user_id, member_ids, "owner_user_id")
        _validate_action_card_references(output.action_cards, member_ids, stage_ids, task_ids, errors)

    if errors:
        raise ValueError("; ".join(errors))


def _validate_action_card_references(
    action_cards: list[ActionCardProposal],
    member_ids: set[str],
    stage_ids: set[str],
    task_ids: set[str],
    errors: list[str],
) -> None:
    for card in action_cards:
        if card.user_id and card.user_id not in member_ids:
            errors.append(f"user_id references unknown id: {card.user_id}")
        if card.stage_id and card.stage_id not in stage_ids:
            errors.append(f"stage_id references unknown id: {card.stage_id}")
        if card.task_id and card.task_id not in task_ids:
            errors.append(f"task_id references unknown id: {card.task_id}")


def _validate_risk_references(
    risks: list[RiskProposal],
    stage_ids: set[str],
    task_ids: set[str],
    errors: list[str],
) -> None:
    for risk in risks:
        if risk.stage_id and risk.stage_id not in stage_ids:
            errors.append(f"stage_id references unknown id: {risk.stage_id}")
        if risk.task_id and risk.task_id not in task_ids:
            errors.append(f"task_id references unknown id: {risk.task_id}")
        _validate_evidence_ids(risk.evidence, stage_ids, task_ids, errors)


def _normalize_user_facing_text(output: AgentOutputBase) -> None:
    """Replace English skill names with Chinese labels in assignment output fields.

    LLM providers may output skill names in their raw form (ai_ml, prompt_engineering).
    This ensures user-facing text uses Chinese labels (AI/ML, Prompt 工程).
    Uses word-boundary regex to avoid corrupting substrings (e.g. 'redesign' → 'reUI 设计').
    """
    if not isinstance(output, AssignmentRecommendationOutput):
        return

    # Build a single regex that matches any skill key as a whole word/underscore-token.
    # Sort by length descending so longer keys (prompt_engineering) match before shorter
    # substrings (engineering) if they ever overlap.
    # Use ASCII-only boundaries ([a-zA-Z0-9_]) instead of \w because Python \w
    # includes Unicode (Chinese) characters, which would prevent matching before 中文 text.
    sorted_pairs = sorted(SKILL_NAME_CN_MAP.items(), key=lambda kv: -len(kv[0]))
    pattern = re.compile(
        r"(?<![a-zA-Z0-9_])(" + "|".join(re.escape(k) for k, _ in sorted_pairs) + r")(?![a-zA-Z0-9_])"
    )

    for assignment in output.assignments:
        for field_name in (
            "skill_match",
            "availability_match",
            "preference_match",
            "constraint_respected",
            "risk_note",
            "reason",
        ):
            value = getattr(assignment, field_name, None)
            if not value or not isinstance(value, str):
                continue
            value = pattern.sub(lambda m: SKILL_NAME_CN_MAP.get(m.group(0), m.group(0)), value)
            setattr(assignment, field_name, value)


def _validate_evidence_ids(
    evidence: list[str | dict[str, Any]],
    stage_ids: set[str],
    task_ids: set[str],
    errors: list[str],
) -> None:
    """Check that task_id / stage_id values inside evidence dicts reference known entities."""
    for item in evidence:
        if not isinstance(item, dict):
            continue
        for key, valid_set, label in [
            ("task_id", task_ids, "evidence.task_id"),
            ("stage_id", stage_ids, "evidence.stage_id"),
        ]:
            value = item.get(key)
            if isinstance(value, str) and value and value not in valid_set:
                errors.append(f"{label} references unknown id: {value}")
