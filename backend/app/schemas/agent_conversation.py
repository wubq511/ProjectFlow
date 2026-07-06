from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


AgentConversationStatus = Literal["active", "archived"]
AgentMessageRole = Literal["user", "assistant", "tool"]


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
