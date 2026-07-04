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
    mode: Literal["sync", "async"] = "sync"
    concurrency_group: str | None = None
    max_concurrency: int = 1
    provider_parallel_tool_calls_allowed: bool = False


class ToolRetryConfig(BaseModel):
    """Retry configuration for tool."""
    max_retries: int = 0
    retry_on: list[str] = Field(default_factory=list)


class ToolBackendConfig(BaseModel):
    """Backend ownership and endpoint."""
    owner: str = "fastapi"
    endpoint: str


class ToolEffectConfig(BaseModel):
    """Side effect configuration."""
    effect_type: ToolEffectType = ToolEffectType.runtime_metadata
    idempotency_key_required: bool = True
    replay_safe: bool = True


class ToolProposalConfig(BaseModel):
    """Proposal confirmation requirements."""
    requires_confirmation: bool = False
    confirmation_timeout_ms: int = 300000


class ToolPrivacyConfig(BaseModel):
    """Privacy settings for tool results."""
    include_sensitive_data: bool = False
    log_raw_payload: bool = False


class ToolErrorConfig(BaseModel):
    """Error handling configuration."""
    fallback_strategy: Literal["none", "template", "retry"] = "none"
    max_retries: int = 0


class ToolResumeConfig(BaseModel):
    """Resume behavior after interruption."""
    replay_safe: bool = True
    requires_idempotency_key: bool = True


class ToolTraceConfig(BaseModel):
    """Trace recording configuration."""
    record_input: bool = True
    record_output: bool = True
    record_timing: bool = True


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
    human_triggered_only: bool = False
    read_only: bool = False
    destructive: bool = False
    idempotent: bool = True
    open_world: bool = False
    timeout_ms: int = 30000
    execution: ToolExecutionConfig = Field(default_factory=ToolExecutionConfig)
    retry: ToolRetryConfig = Field(default_factory=ToolRetryConfig)
    result_limit: int = 10000
    backend: ToolBackendConfig
    effects: ToolEffectConfig = Field(default_factory=ToolEffectConfig)
    proposal_confirmation: ToolProposalConfig = Field(default_factory=ToolProposalConfig)
    privacy: ToolPrivacyConfig = Field(default_factory=ToolPrivacyConfig)
    errors: ToolErrorConfig = Field(default_factory=ToolErrorConfig)
    resume: ToolResumeConfig = Field(default_factory=ToolResumeConfig)
    trace: ToolTraceConfig = Field(default_factory=ToolTraceConfig)


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
    read_only: Literal[False] = False
    destructive: Literal[False] = False
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


# ─── Append API Request/Response ────────────────────────────────────────────


class EventAppendItem(BaseModel):
    """Single event in an append request."""
    client_event_id: str
    type: RuntimeEventType
    ordering_hint: int = 0
    payload: dict[str, Any] = Field(default_factory=dict)


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
    state_patch: dict[str, Any] | None = None
    events: list[EventAppendItem] = Field(default_factory=list)
    tool_results: list[ToolResultAppendItem] = Field(default_factory=list)


class EventAppendResponse(BaseModel):
    """Response for a single appended event."""
    client_event_id: str
    agent_event_id: str
    event_seq: int


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
    workspace_state: dict[str, Any] = Field(default_factory=dict)
    recent_messages: list[dict[str, Any]] = Field(default_factory=list)
    pending_proposals: list[dict[str, Any]] = Field(default_factory=list)
    runtime_config: RuntimeConfig = Field(default_factory=RuntimeConfig)


class RunStartResponse(BaseModel):
    """Response from starting a run."""
    run_id: str
    status: AgentRunStatus = AgentRunStatus.created


class RunStatusResponse(BaseModel):
    """Response for run status query."""
    run_id: str
    status: AgentRunStatus
    current_turn: int = 0
    current_step: int = 0
    last_event_seq: int = 0
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
