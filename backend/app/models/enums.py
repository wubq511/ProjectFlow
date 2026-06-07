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


class AgentEventStatus(str, Enum):
    success = "success"
    repaired = "repaired"
    fallback = "fallback"
    failed = "failed"


class AgentProposalStatus(str, Enum):
    pending = "pending"
    confirmed = "confirmed"
    rejected = "rejected"
