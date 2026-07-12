"""T41 Runtime Foundation Schemas.

Defines the core types for Agent Runtime: AgentRunState, Tool Manifest,
ProjectFlowToolResult, RuntimeEvent, TraceEnvelope, Error Model, and
HumanActionManifest.

All JSON/YAML payloads use snake_case. TypeScript sidecar uses camelCase
internally but converts via adapter.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models.enums import (
    AgentRunStatus,
    HumanActionType,
    RuntimeEventType,
    SideEffectStatus,
    ToolEffectType,
    ToolResultStatus,
    ToolRiskCategory,
)


# ─── AgentRunState (wire format) ────────────────────────────────────────────


class PendingToolCall(BaseModel):
    """Currently executing tool call."""
    tool_call_id: str
    tool_name: str
    tool_version: int
    idempotency_key: str


class SideEffect(BaseModel):
    """Recorded side effect from a tool execution."""
    tool_call_id: str
    status: SideEffectStatus


class ResumePolicy(BaseModel):
    """Resume policy for the run."""
    manifest_version: int = 1
    requires_regeneration_on_mismatch: bool = True


class AgentRunState(BaseModel):
    """Durable run state persisted in FastAPI DB.

    Sidecar submits patches; FastAPI is the source of truth.
    """
    schema_version: int = 1
    run_id: str
    conversation_id: str
    workspace_id: str
    project_id: str
    status: AgentRunStatus = AgentRunStatus.created
    current_turn: int = 0
    current_step: int = 0
    model: dict[str, str] = Field(default_factory=lambda: {"provider": "", "name": ""})
    pending_tool_call: PendingToolCall | None = None
    side_effects: list[SideEffect] = Field(default_factory=list)
    last_event_seq: int = 0
    resume_policy: ResumePolicy = Field(default_factory=ResumePolicy)


# ─── Tool Manifest ──────────────────────────────────────────────────────────


class ToolExecutionConfig(BaseModel):
    """Execution mode and concurrency settings."""
    mode: Literal["parallel", "sequential"] = "sequential"
    concurrency_group: str | None = None
    max_concurrency: int = 1
    provider_parallel_tool_calls_allowed: bool = False


class ToolRetryConfig(BaseModel):
    """Retry configuration for tool."""
    max_attempts: int = 1
    retry_on: list[str] = Field(default_factory=list)


class ToolBackendConfig(BaseModel):
    """Backend ownership and endpoint."""
    owner: str = "fastapi"
    endpoint: str


class ToolEffectConfig(BaseModel):
    """Side effect configuration."""
    effect_type: ToolEffectType = ToolEffectType.event_write
    idempotency_key_required: bool = True
    replay_safe: bool = True


class ToolProposalConfig(BaseModel):
    """Proposal confirmation requirements."""
    creates_proposal: bool = False
    required_before_commit: bool = False
    public_action_only: bool = True
    resumes_model_loop_by_default: Literal[False] = False


class ToolPrivacyConfig(BaseModel):
    """Privacy settings for tool results."""
    data_classification: Literal["public", "project_sensitive", "secret"] = "project_sensitive"
    trace_include_inputs: bool = False
    trace_include_outputs: bool = False


class ToolErrorConfig(BaseModel):
    """Error handling configuration."""
    model_visible_error_policy: Literal["normalized_summary", "redacted", "none"] = "normalized_summary"


class ToolResumeConfig(BaseModel):
    """Resume behavior after interruption."""
    manifest_version: int = 1
    incompatible_version_policy: Literal["regenerate", "manual_review", "fail"] = "regenerate"


class ToolTraceConfig(BaseModel):
    """Trace recording configuration."""
    emits: list[str] = Field(default_factory=list)


class ToolAnnotations(BaseModel):
    """Tool behavioral annotations."""
    read_only: bool = False
    destructive: bool = False
    idempotent: bool = True
    open_world: bool = False


class ToolResultLimit(BaseModel):
    """Result size and redaction limits."""
    max_bytes: int = 65536
    redaction: Literal["none", "secrets", "pii"] = "none"


class ToolExecutionApprovalExtension(BaseModel):
    """ToolExecutionApproval extension — future scope, not yet runtime-supported."""
    current_runtime_supported: Literal[False] = False
    future_approval_scope: Literal["tool_call"] | None = None


class ToolResourceCreate(BaseModel):
    resource_id: str = Field(min_length=1, max_length=160)
    tool_call_id: str = Field(min_length=1, max_length=160)
    tool_name: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=1_048_576)
    content_type: Literal["application/json", "text/plain"] = "application/json"


class ToolResourceRead(BaseModel):
    resource_id: str
    run_id: str
    tool_name: str
    content_type: str
    content_base64: str
    cursor: int
    next_cursor: int | None = None
    has_more: bool
    total_bytes: int
    content_hash: str


class ToolManifest(BaseModel):
    """Capability manifest for a ProjectFlow tool.

    Describes what a tool does, its risk category, execution mode,
    and all policy/privacy/resume constraints.
    """
    schema_version: int = 1
    name: str
    version: int = 1
    description: str
    risk_category: ToolRiskCategory
    model_callable: bool = True
    sidecar_only: bool = False
    human_triggered_only: bool = False
    annotations: ToolAnnotations = Field(default_factory=ToolAnnotations)
    timeout_ms: int = 30000
    execution: ToolExecutionConfig = Field(default_factory=ToolExecutionConfig)
    retry: ToolRetryConfig = Field(default_factory=ToolRetryConfig)
    result_limit: ToolResultLimit = Field(default_factory=ToolResultLimit)
    backend: ToolBackendConfig
    effects: ToolEffectConfig = Field(default_factory=ToolEffectConfig)
    proposal_confirmation: ToolProposalConfig = Field(default_factory=ToolProposalConfig)
    privacy: ToolPrivacyConfig = Field(default_factory=ToolPrivacyConfig)
    errors: ToolErrorConfig = Field(default_factory=ToolErrorConfig)
    resume: ToolResumeConfig = Field(default_factory=ToolResumeConfig)
    trace: ToolTraceConfig = Field(default_factory=ToolTraceConfig)
    tool_execution_approval_extension: ToolExecutionApprovalExtension | None = None


# ─── HumanActionManifest ────────────────────────────────────────────────────


class HumanActionManifest(BaseModel):
    """Manifest for human-triggered actions.

    model_callable=False, human_triggered_only=True.
    These are actions that only humans can perform (confirm, reject, commit).
    """
    schema_version: int = 1
    name: str
    version: int = 1
    description: str
    action_type: HumanActionType
    model_callable: Literal[False] = False
    human_triggered_only: Literal[True] = True
    risk_category: Literal["internal_write"] = "internal_write"
    annotations: ToolAnnotations = Field(
        default_factory=lambda: ToolAnnotations(read_only=False, destructive=False)
    )
    timeout_ms: int = 0
    backend: ToolBackendConfig
    effects: ToolEffectConfig


# ─── ProjectFlowToolResult ──────────────────────────────────────────────────


class ToolError(BaseModel):
    """Structured error information."""
    code: str
    reason: str
    message: str
    details: dict[str, Any] | None = None


class ToolLinks(BaseModel):
    """Links to related entities created/modified by the tool."""
    agent_event_id: str | None = None
    agent_run_id: str | None = None
    proposal_id: str | None = None
    created_ids: list[str] = Field(default_factory=list)


class ProjectFlowToolResult(BaseModel):
    """Unified result structure for all tool executions.

    Each tool call produces exactly one terminal result.
    LLM-callable tools must not return commit_persisted side_effect_status.
    """
    status: ToolResultStatus
    data: dict[str, Any] | None = None
    error: ToolError | None = None
    side_effect_status: SideEffectStatus = SideEffectStatus.no_side_effect
    idempotency_key: str | None = None
    links: ToolLinks = Field(default_factory=ToolLinks)
    observation: str = ""
    trace: dict[str, Any] | None = None


# ─── RuntimeEvent ───────────────────────────────────────────────────────────


class RuntimeEventState(BaseModel):
    """State snapshot at event time."""
    status: AgentRunStatus
    schema_version: int = 1


class RuntimeEvent(BaseModel):
    """Event emitted during runtime lifecycle.

    event_seq is assigned by FastAPI in append response,
    not by sidecar local counter.
    """
    type: RuntimeEventType
    run_id: str
    event_seq: int = 0
    timestamp: datetime | None = None
    state: RuntimeEventState | None = None
    trace: dict[str, Any] | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


# ─── TraceEnvelope ──────────────────────────────────────────────────────────


class TraceSpan(BaseModel):
    """Individual trace span for timing."""
    name: str
    start_ms: int
    end_ms: int | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)


class TraceEnvelope(BaseModel):
    """Trace envelope linking run, tool calls, and proposals.

    Defaults to not including sensitive data.
    """
    run_id: str
    tool_call_id: str | None = None
    tool_name: str | None = None
    proposal_id: str | None = None
    spans: list[TraceSpan] = Field(default_factory=list)
    attributes: dict[str, Any] = Field(default_factory=dict)
    include_sensitive_data: bool = False


# ─── Internal Tool Execution API ────────────────────────────────────────────


class ToolExecutionRequest(BaseModel):
    """Unified envelope for POST /internal/agent-tools/{tool_name}.

    Sidecar submits this; FastAPI dispatches to the tool handler and returns
    a ProjectFlowToolResult. Read-only tools express read-only semantics via
    the manifest (risk_category=read_only), not via HTTP method.
    """

    run_id: str
    tool_call_id: str
    conversation_id: str
    workspace_id: str
    project_id: str
    tool_name: str
    tool_version: int = 1
    manifest_version: int = 1
    idempotency_key: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    client_event_id: str | None = None
    ordering_hint: int = 0
    trace: dict[str, Any] = Field(default_factory=dict)


# ─── Append API Request/Response ────────────────────────────────────────────


class EventAppendItem(BaseModel):
    """Single event in an append request."""
    client_event_id: str
    type: RuntimeEventType
    ordering_hint: int = 0
    payload: dict[str, Any] = Field(default_factory=dict)
    trace: dict[str, Any] = Field(default_factory=dict)


class ToolResultAppendItem(BaseModel):
    """Single tool result in an append request."""
    tool_call_id: str
    tool_name: str
    tool_version: int = 1
    result: ProjectFlowToolResult


class AppendRequest(BaseModel):
    """Request to append events and state patches to a run.

    Sidecar submits this; FastAPI processes atomically.
    """
    idempotency_key: str
    expected_state_version: int | None = Field(
        default=None,
        description="Optimistic concurrency: compare against run.state_version; stale requests return 409",
    )
    state_patch: dict[str, Any] | None = None
    events: list[EventAppendItem] = Field(default_factory=list)
    tool_results: list[ToolResultAppendItem] = Field(default_factory=list)


class EventAppendResponse(BaseModel):
    """Response for a single appended event."""
    client_event_id: str
    agent_event_id: str
    event_seq: int


class RuntimeEventRead(BaseModel):
    """Persisted runtime event returned by the internal query endpoint."""
    id: str
    run_id: str
    conversation_id: str | None = None
    workspace_id: str
    project_id: str
    type: RuntimeEventType
    event_seq: int
    client_event_id: str
    ordering_hint: int
    payload: dict[str, Any] = Field(default_factory=dict)
    trace: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class ToolResultAppendResponse(BaseModel):
    """Response for a single appended tool result."""
    tool_call_id: str
    agent_event_id: str | None = None
    persisted: bool = True


class AppendResponse(BaseModel):
    """Response from append API."""
    state_version: int
    events: list[EventAppendResponse] = Field(default_factory=list)
    tool_results: list[ToolResultAppendResponse] = Field(default_factory=list)


# ─── Run API Request/Response ───────────────────────────────────────────────


class RuntimeConfig(BaseModel):
    """Runtime configuration for a run."""
    model: str = ""
    max_steps: int = 8
    max_tool_calls: int = 6
    timeout_ms: int = 180000
    trace_include_sensitive_data: bool = False


class RunStartRequest(BaseModel):
    """Request to start a new agent run."""
    conversation_id: str
    workspace_id: str
    project_id: str
    user_message_id: str | None = None
    user_content: str
    viewer_user_id: str | None = Field(default=None, description="Required viewer user ID for memory visibility filtering; service returns 400 if missing")
    workspace_state: dict[str, Any] = Field(default_factory=dict)
    recent_messages: list[dict[str, Any]] = Field(default_factory=list)
    pending_proposals: list[dict[str, Any]] = Field(default_factory=list)
    memory_mode: Literal["enabled", "disabled"] = "enabled"
    runtime_config: RuntimeConfig = Field(default_factory=RuntimeConfig)


class RunStartResponse(BaseModel):
    """Response from starting a run."""
    run_id: str
    status: AgentRunStatus = AgentRunStatus.created
    memory_context: dict[str, Any] | None = None


class RunStatusResponse(BaseModel):
    """Response for run status query."""
    run_id: str
    status: AgentRunStatus
    current_turn: int = 0
    current_step: int = 0
    last_event_seq: int = 0
    state_version: int = 0
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class RunCancelRequest(BaseModel):
    """Request to cancel a running agent run."""
    reason: str | None = None


class RunCancelResponse(BaseModel):
    """Response from cancelling a run."""
    run_id: str
    status: AgentRunStatus
    cancelled: bool = True


# ─── Snapshot API (Phase 5: Checkpoint + Resume) ───────────────────────────


class RunSnapshotResponse(BaseModel):
    """Durable snapshot of a run for resume/rehydrate.

    Contains the current run state, latest checkpoint, and recent events.
    Bounded/redacted — no raw workspace_state, secrets, or chain-of-thought.
    """
    run_id: str
    conversation_id: str
    workspace_id: str
    project_id: str
    status: AgentRunStatus
    current_turn: int = 0
    current_step: int = 0
    last_event_seq: int = 0
    state_version: int = 0
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    side_effects: list[dict[str, Any]] = Field(default_factory=list)
    latest_checkpoint: dict[str, Any] | None = None
    recent_events: list[dict[str, Any]] = Field(default_factory=list)


# ─── Steering API (Phase 5: Steering Queue) ────────────────────────────────


STEERING_TYPES = Literal[
    "constraint",           # user adds a constraint/correction
    "correction",           # user corrects a previous statement
    "plan_change",          # user requests plan modification
    "clarification_answer", # user answers a clarification question
    "approval_response",    # user approves/denies an effect request
    "cancel",               # user cancels the run
]


class SteeringRequest(BaseModel):
    """Request to append a steering event to a run.

    Uses client_message_id for idempotency — duplicate messages are ignored.
    The steering event is queued and consumed at the next loop boundary.
    """
    steering_type: STEERING_TYPES
    content: str
    client_message_id: str = Field(description="Idempotency key for duplicate detection")
    expected_state_version: int | None = Field(
        default=None,
        description="Optimistic concurrency: compare against run.state_version; stale requests return 409",
    )
    metadata: dict[str, Any] = Field(default_factory=dict)


class SteeringResponse(BaseModel):
    """Response from appending a steering event."""
    run_id: str
    steering_seq: int
    state_version: int = 0
    accepted: bool = True
    message: str = "已接收"
