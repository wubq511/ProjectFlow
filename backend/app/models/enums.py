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
    runtime_metadata = "runtime_metadata"
    reviewable_draft = "reviewable_draft"
    advisory_write = "advisory_write"
    primary_commit = "primary_commit"


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


class HumanActionType(str, Enum):
    """Types of human-triggered actions."""
    confirm_proposal = "confirm_proposal"
    reject_proposal = "reject_proposal"
    cancel_run = "cancel_run"
    commit_proposal = "commit_proposal"
