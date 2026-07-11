import re
from datetime import datetime
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator, model_validator


AgentConversationStatus = Literal["active", "archived"]
AgentMessageRole = Literal["user", "assistant", "tool"]


# ---------------------------------------------------------------------------
# SSE streaming event schemas (strict validation)
# ---------------------------------------------------------------------------


class StreamContentEventSchema(BaseModel):
    """Strict Pydantic schema for SSE `content` events from sidecar."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["thinking", "text"]
    phase: Literal["start", "delta", "end"]
    content_index: int = Field(ge=0, strict=True)
    message_seq: int = Field(ge=0, strict=True)
    content: str | None = None

    @model_validator(mode="after")
    def validate_content(self):
        if self.phase == "delta" and self.content is None:
            raise ValueError("content required for delta phase")
        if self.phase != "delta" and self.content is not None:
            raise ValueError("content only allowed for delta phase")
        return self


class StreamStatusEventSchema(BaseModel):
    """User-safe status event emitted by the sidecar."""

    model_config = ConfigDict(extra="forbid")
    phase: Literal["planning", "executing", "generating", "streaming", "answering"]
    message: str = Field(min_length=1, strict=True)

    @field_validator("message")
    @classmethod
    def validate_user_safe_message(cls, value: str) -> str:
        if not re.search(r"[\u4e00-\u9fff]", value):
            raise ValueError("status message must contain Chinese user-facing text")
        if re.search(r"\b(?:project|workspace|user|task|tool|run|conversation)_id\b", value, re.I):
            raise ValueError("status message must not expose raw identifiers")
        if re.search(r"\b[0-9a-f]{8}-[0-9a-f-]{27,}\b", value, re.I):
            raise ValueError("status message must not expose UUIDs")
        return value


class StreamErrorEventSchema(BaseModel):
    """User-safe terminal error event emitted by the sidecar."""

    model_config = ConfigDict(extra="forbid")
    message: Literal[
        "Agent 预算已用尽，请稍后重试。",
        "操作被策略拦截，请检查后重试。",
        "Agent 响应超时，请稍后重试。",
        "Agent 运行时错误，请稍后重试。",
        "Agent 处理失败，请稍后重试。",
        "运行已取消",
        "Agent 执行出错，请稍后重试。",
    ]


class StreamToolStartedSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phase: Literal["started"]
    tool_call_id: str = Field(min_length=1, strict=True)
    tool_name: str = Field(min_length=1, strict=True)
    label: str = Field(min_length=1, strict=True)


class StreamToolCompletedSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phase: Literal["completed"]
    tool_call_id: str = Field(min_length=1, strict=True)
    tool_name: str = Field(min_length=1, strict=True)


class StreamToolFailedSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phase: Literal["failed"]
    tool_call_id: str = Field(min_length=1, strict=True)
    tool_name: str = Field(min_length=1, strict=True)


class StreamToolBlockedSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phase: Literal["blocked"]
    tool_call_id: str | None = None
    tool_name: str | None = None
    label: str = Field(min_length=1, strict=True)
    event_id: str = Field(min_length=1, strict=True)


class StreamToolEventSchema(RootModel):
    """Discriminated union of tool lifecycle events. RootModel provides model_validate."""
    root: Annotated[
        Union[StreamToolStartedSchema, StreamToolCompletedSchema, StreamToolFailedSchema, StreamToolBlockedSchema],
        Field(discriminator="phase"),
    ]


class StreamDoneExecutionStepSchema(BaseModel):
    """Strict schema for a single execution step in the done payload."""
    model_config = ConfigDict(extra="forbid")
    tool_name: str = Field(min_length=1, strict=True)
    tool_call_id: str | None = None
    status: Literal["started", "completed", "failed", "blocked"]
    label: str = Field(min_length=1, strict=True)


class StreamDonePayloadSchema(BaseModel):
    """Strict schema for the done event payload from sidecar.

    Matches the wire format produced by sidecar's buildDonePayload:
    {run_id, status, final_content, thinking_content?, execution_steps?}

    final_content is required — a done without an answer is malformed.
    """
    model_config = ConfigDict(extra="forbid")
    run_id: str = Field(min_length=1, strict=True)
    status: Literal["completed"]
    final_content: str = Field(min_length=0, strict=True)
    thinking_content: str = ""
    execution_steps: list[StreamDoneExecutionStepSchema] = Field(default_factory=list)


class AgentTurnPlan(BaseModel):
    response_type: Literal[
        "answer",
        "ask_clarifying_question",
        "run_module",
        "revise_pending_proposal",
    ]
    selected_module: Literal[
        "clarify",
        "plan",
        "breakdown",
        "assign",
        "push",
        "checkin",
        "risk",
        "replan",
    ] | None = None
    user_instruction: str = ""
    rationale: str
    required_inputs: list[str] = Field(default_factory=list)
    expected_artifact: str | None = None
    risk_level: Literal["low", "medium", "high"] = "low"
    requires_confirmation: bool = False


class AgentConversationMessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    viewer_user_id: str | None = None


class AgentMessageRead(BaseModel):
    id: str
    conversation_id: str
    role: AgentMessageRole | str
    content: str
    structured_payload: dict[str, Any]
    linked_event_id: str | None
    linked_proposal_id: str | None
    created_at: datetime


class AgentRunRead(BaseModel):
    id: str
    conversation_id: str
    project_id: str
    user_instruction: str
    selected_module: str
    status: str
    model: str
    attempts: int
    verifier_status: str
    agent_event_id: str | None
    proposal_id: str | None
    created_at: datetime
    completed_at: datetime | None


class AgentConversationRead(BaseModel):
    id: str
    workspace_id: str
    project_id: str
    status: AgentConversationStatus | str
    summary: str
    current_focus: str
    messages: list[AgentMessageRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class AgentSuggestionRead(BaseModel):
    id: str
    label: str
    user_instruction: str
    priority: Literal["primary", "secondary"] = "secondary"


class AgentArtifactRead(BaseModel):
    id: str
    type: Literal[
        "proposal",
        "risk_analysis",
        "action_card",
        "assignment",
        "direction",
        "plan",
    ]
    status: Literal[
        "draft",
        "pending_confirmation",
        "confirmed",
        "dismissed",
        "expired",
    ]
    title: str
    summary: str
    rationale: str
    impact: list[str] = Field(default_factory=list)
    linked_entity_ids: list[str] = Field(default_factory=list)


class AgentConversationTurnRead(BaseModel):
    conversation: AgentConversationRead
    user_message: AgentMessageRead
    assistant_message: AgentMessageRead
    run: AgentRunRead | None
    turn_plan: AgentTurnPlan | None
    next_suggestions: list[str] = Field(default_factory=list)
    suggestions: list[AgentSuggestionRead] = Field(default_factory=list)
    artifacts: list[AgentArtifactRead] = Field(default_factory=list)
