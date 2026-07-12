from enum import Enum


class WorkspaceRole(str, Enum):
    owner = "owner"
    member = "member"


class InvitationStatus(str, Enum):
    pending = "pending"
    accepted = "accepted"
    expired = "expired"


class ProjectStatus(str, Enum):
    draft = "draft"
    active = "active"
    at_risk = "at_risk"
    completed = "completed"


class ResourceType(str, Enum):
    text_note = "text_note"
    file_stub = "file_stub"
    link = "link"


class StageStatus(str, Enum):
    pending = "pending"
    active = "active"
    completed = "completed"
    at_risk = "at_risk"


class TaskPriority(str, Enum):
    P0 = "P0"
    P1 = "P1"
    P2 = "P2"


class TaskStatus(str, Enum):
    not_started = "not_started"
    in_progress = "in_progress"
    done = "done"
    blocked = "blocked"
    cancelled = "cancelled"


class AssignmentProposalStatus(str, Enum):
    proposed = "proposed"
    owner_confirmed = "owner_confirmed"
    owner_rejected = "owner_rejected"
    negotiating = "negotiating"
    finalized = "finalized"


class AssignmentResponseType(str, Enum):
    accept = "accept"
    reject = "reject"


class NegotiationStatus(str, Enum):
    pending = "pending"
    accepted = "accepted"
    declined = "declined"
    resolved = "resolved"


class CheckInCycleStatus(str, Enum):
    active = "active"
    paused = "paused"
    completed = "completed"


class MoodOrConfidence(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class RiskType(str, Enum):
    deadline = "deadline"
    dependency = "dependency"
    workload = "workload"
    scope = "scope"
    review = "review"
    assignment = "assignment"
    checkin = "checkin"


class RiskSeverity(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class RiskStatus(str, Enum):
    open = "open"
    accepted = "accepted"
    ignored = "ignored"
    resolved = "resolved"


class ActionCardType(str, Enum):
    personal_task = "personal_task"
    team_next_step = "team_next_step"
    reminder = "reminder"
    risk_action = "risk_action"
    kickoff_tip = "kickoff_tip"
    checkin_prompt = "checkin_prompt"
    assignment_request = "assignment_request"
    suggestion = "suggestion"


class ActionCardStatus(str, Enum):
    active = "active"
    done = "done"
    dismissed = "dismissed"


class AgentEventType(str, Enum):
    clarify = "clarify"
    plan = "plan"
    breakdown = "breakdown"
    assign = "assign"
    negotiate = "negotiate"
    push = "push"
    checkin = "checkin"
    risk = "risk"
    replan = "replan"
    export = "export"
    retrospective = "retrospective"


class AgentEventStatus(str, Enum):
    success = "success"
    repaired = "repaired"
    fallback = "fallback"
    failed = "failed"


class AgentProposalStatus(str, Enum):
    pending = "pending"
    confirmed = "confirmed"
    rejected = "rejected"


# ─── T41 Runtime Enums ─────────────────────────────────────────────────────


class AgentRunStatus(str, Enum):
    """Agent run lifecycle states."""
    created = "created"
    context_building = "context_building"
    model_streaming = "model_streaming"
    tool_preparing = "tool_preparing"
    tool_running = "tool_running"
    persisting_tool_result = "persisting_tool_result"
    completed = "completed"
    cancelling = "cancelling"
    cancelled = "cancelled"
    failed = "failed"


class ToolEffectType(str, Enum):
    """Write boundary classification for tools."""
    none = "none"
    event_write = "event_write"
    proposal_create = "proposal_create"
    advisory_record_create = "advisory_record_create"
    runtime_metadata_write = "runtime_metadata_write"


class ToolRiskCategory(str, Enum):
    """Risk categories for tool execution."""
    read_only = "read_only"
    analysis = "analysis"
    draft_only = "draft_only"
    advisory_write = "advisory_write"
    internal_write = "internal_write"
    destructive = "destructive"
    open_world = "open_world"


class SideEffectStatus(str, Enum):
    """Status of side effects after tool execution."""
    no_side_effect = "no_side_effect"
    event_persisted = "event_persisted"
    proposal_persisted = "proposal_persisted"
    advisory_record_persisted = "advisory_record_persisted"
    commit_persisted = "commit_persisted"
    unknown = "unknown"


class ToolResultStatus(str, Enum):
    """Terminal status for tool results."""
    success = "success"
    blocked = "blocked"
    failed = "failed"
    aborted = "aborted"
    timeout = "timeout"
    validation_error = "validation_error"


class RuntimeEventType(str, Enum):
    """Event types for runtime lifecycle."""
    run_started = "run.started"
    run_completed = "run.completed"
    run_failed = "run.failed"
    run_cancelled = "run.cancelled"
    tool_started = "tool.started"
    tool_completed = "tool.completed"
    tool_blocked = "tool.blocked"
    tool_failed = "tool.failed"
    model_streaming = "model.streaming"
    state_changed = "state.changed"
    proposal_created = "proposal.created"
    proposal_confirmed = "proposal.confirmed"
    proposal_rejected = "proposal.rejected"
    runtime_error = "runtime.error"
    agent_started = "agent.started"
    agent_status = "agent.status"
    agent_delta = "agent.delta"
    agent_completed = "agent.completed"
    agent_failed = "agent.failed"
    agent_output_captured = "agent.output_captured"
    tool_progress = "tool.progress"
    advisory_record_created = "advisory_record.created"
    proposal_confirmation_confirmed = "proposal_confirmation.confirmed"
    proposal_confirmation_rejected = "proposal_confirmation.rejected"
    proposal_confirmation_committed = "proposal_confirmation.committed"
    run_state_changed = "run.state_changed"
    work_state_changed = "work_state.changed"
    run_plan_created = "run_plan.created"
    run_plan_step_updated = "run_plan.step_updated"
    verifier_completed = "verifier.completed"
    tool_ledger_entry = "tool.ledger_entry"
    checkpoint_saved = "checkpoint.saved"
    steering_queued = "steering.queued"
    steering_consumed = "steering.consumed"


class HumanActionType(str, Enum):
    """Types of human-triggered actions."""
    confirm_proposal = "confirm_proposal"
    reject_proposal = "reject_proposal"
    cancel_run = "cancel_run"
    commit_proposal = "commit_proposal"


# ─── T42 ProjectMemory Enums ────────────────────────────────────────────────


class MemorySourceType(str, Enum):
    """Memory Source Event types that can produce ProjectMemory."""
    direction_card_confirmed = "direction_card_confirmed"
    proposal_rejected = "proposal_rejected"
    assignment_confirmed = "assignment_confirmed"
    replan_confirmed = "replan_confirmed"
    replan_rejected = "replan_rejected"


class MemoryType(str, Enum):
    """Types of governed project memory."""
    direction = "direction"
    boundary = "boundary"
    plan = "plan"
    assignment = "assignment"
    tradeoff = "tradeoff"
    rejection = "rejection"
    member_constraint = "member_constraint"


class MemoryStatus(str, Enum):
    """Lifecycle status of ProjectMemory."""
    active = "active"
    superseded = "superseded"
    archived = "archived"


class MemoryVisibility(str, Enum):
    """Visibility scope of ProjectMemory."""
    team = "team"
    subject_and_owner = "subject_and_owner"


class MemoryScope(str, Enum):
    """Scope level of ProjectMemory."""
    project = "project"
    stage = "stage"
    task = "task"
    member = "member"
