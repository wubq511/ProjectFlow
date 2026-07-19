"""T46-2 Evaluation Evidence Snapshot schemas.

Normalized, viewer-scoped, read-only facts exposed to deterministic graders.

Design constraints (see docs/T46/ProjectFlow_Agent_Evaluation_Lab_Spec.md):

- The snapshot is NOT a raw database dump. It only returns grader-required
  normalized state/proposal/event/memory/conversation/trajectory/metric facts.
- Viewer-sensitive collections (conversations, ProjectMemory) are filtered by
  the same authorization predicate used by the public read surfaces, so the
  snapshot cannot bypass viewer visibility.
- Subject-and-owner ProjectMemory content is included only when the viewer is
  authorized; otherwise only structural facts (memory_type, scope, status,
  visibility, presence flags) are returned.
- No absolute local paths, no secrets, no hidden goal text, no unrelated raw
  IDs, no input/output snapshot blobs, no payload values, no trace payloads.
- schema_version is independent from the artifact schema version: it tracks the
  evidence contract surfaced to graders. Bumping it requires a grader update.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

EVALUATION_EVIDENCE_SCHEMA_VERSION = 1


class StageFacts(BaseModel):
    stage_id: str
    name: str
    status: str
    order_index: int


class TaskFacts(BaseModel):
    task_id: str
    title: str
    status: str
    priority: str
    stage_id: str
    owner_user_id: str | None = None
    backup_owner_user_id: str | None = None


class MemberFacts(BaseModel):
    user_id: str
    display_name: str


class AssignmentProposalFacts(BaseModel):
    proposal_id: str
    stage_id: str
    task_id: str
    recommended_owner_user_id: str | None
    backup_owner_user_id: str | None
    status: str


class StateFacts(BaseModel):
    workspace_id: str
    workspace_name: str
    project_id: str | None = None
    project_name: str | None = None
    project_status: str | None = None
    project_current_stage_id: str | None = None
    project_deadline: str | None = None
    stage_count: int
    stages: list[StageFacts] = Field(default_factory=list)
    task_count: int
    tasks: list[TaskFacts] = Field(default_factory=list)
    assignment_proposal_count: int = 0
    assignment_proposals: list[AssignmentProposalFacts] = Field(default_factory=list)
    member_count: int
    members: list[MemberFacts] = Field(default_factory=list)


class ProposalFacts(BaseModel):
    proposal_id: str
    proposal_type: str
    status: str
    confirmed_by_present: bool
    confirmed_at_present: bool
    rejection_reason_present: bool
    payload_keys: list[str]
    created_at: str


class EventFacts(BaseModel):
    event_id: str
    event_type: str
    status: str
    user_confirmed: bool
    created_at: str


class MemoryFacts(BaseModel):
    memory_id: str
    memory_type: str
    scope: str
    status: str
    visibility: str
    subject_user_id_present: bool
    owner_user_id_snapshot_present: bool
    related_stage_id_present: bool
    related_task_id_present: bool
    related_risk_id_present: bool
    valid_until_present: bool
    content_visible: bool
    content: str | None = None
    rationale: str | None = None
    created_at: str


class ConversationFacts(BaseModel):
    conversation_id: str
    visibility: str
    creator_user_id: str
    status: str
    message_count: int
    created_at: str
    updated_at: str


class TrajectoryFacts(BaseModel):
    event_type: str
    event_seq: int
    created_at: str


class SideEffectFacts(BaseModel):
    tool_call_id: str
    status: str
    effect_type: str | None = None
    tool_name: str | None = None


class MetricFacts(BaseModel):
    run_id: str
    run_status: str
    model_provider: str
    model_name: str
    resolved_model_provider: str
    resolved_model_name: str
    current_turn: int
    current_step: int
    side_effects_count: int
    last_event_seq: int


class ContextReceiptFacts(BaseModel):
    """Redacted summary of what the run consumed from context sources.

    Only structural identifiers (memory IDs, skill names, tool manifest names)
    are exposed. No memory content, no hidden prompts, no chain-of-thought.
    """

    memory_ids_used: list[str] = Field(default_factory=list)
    skill_names: list[str] = Field(default_factory=list)
    tool_manifest_names: list[str] = Field(default_factory=list)


class EvaluationEvidenceSnapshot(BaseModel):
    schema_version: int = EVALUATION_EVIDENCE_SCHEMA_VERSION
    snapshot_id: str
    captured_at: str
    workspace_id: str
    project_id: str | None = None
    conversation_id: str | None = None
    viewer_user_id: str
    run_id: str | None = None
    state_facts: StateFacts
    proposal_facts: list[ProposalFacts] = Field(default_factory=list)
    event_facts: list[EventFacts] = Field(default_factory=list)
    memory_facts: list[MemoryFacts] = Field(default_factory=list)
    conversation_facts: list[ConversationFacts] = Field(default_factory=list)
    trajectory_facts: list[TrajectoryFacts] = Field(default_factory=list)
    side_effect_facts: list[SideEffectFacts] = Field(default_factory=list)
    metric_facts: MetricFacts | None = None
    context_receipt_facts: ContextReceiptFacts | None = None
