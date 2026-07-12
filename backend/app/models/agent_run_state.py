import json
import uuid
from datetime import datetime, timezone

from sqlmodel import SQLModel, Field
from sqlalchemy import Column, Index, Text

from app.models.enums import AgentRunStatus, RuntimeEventType


class AgentRunV2(SQLModel, table=True):
    """T41 Agent run lifecycle record.

    This is the new runtime model for T41. The legacy AgentRun in
    agent_conversation.py is kept until parity tests pass.
    """
    __tablename__ = "agent_runs_v2"
    __table_args__ = (
        Index("ix_agent_runs_v2_conversation", "conversation_id"),
        Index("ix_agent_runs_v2_project_status", "project_id", "status"),
    )

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    conversation_id: str = Field(foreign_key="agent_conversations.id", index=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    workspace_id: str = Field(foreign_key="workspaces.id", index=True)
    user_message_id: str | None = Field(default=None)
    viewer_user_id: str = Field(default="")
    status: AgentRunStatus = Field(default=AgentRunStatus.created, index=True)
    current_turn: int = Field(default=0)
    current_step: int = Field(default=0)
    model_provider: str = Field(default="")
    model_name: str = Field(default="")
    pending_tool_call_id: str | None = Field(default=None)
    pending_tool_name: str | None = Field(default=None)
    pending_tool_version: int | None = Field(default=None)
    pending_idempotency_key: str | None = Field(default=None)
    side_effects: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    last_event_seq: int = Field(default=0)
    resume_manifest_version: int = Field(default=1)
    state_version: int = Field(default=0)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: datetime | None = Field(default=None)

    # -- helpers for JSON round-trip ----------------------------------------

    def get_side_effects(self) -> list[dict]:
        """Deserialize side_effects from stored JSON string."""
        return json.loads(self.side_effects)

    def set_side_effects(self, value: list[dict]) -> None:
        """Serialize and store side_effects as JSON string."""
        self.side_effects = json.dumps(value, ensure_ascii=False)


class AgentRunEvent(SQLModel, table=True):
    """Persisted T41 runtime event.

    This table is separate from the legacy AgentEvent product timeline because
    runtime event types include tool/run/proposal lifecycle values that are not
    legacy workflow modules.
    """
    __tablename__ = "agent_run_events"
    __table_args__ = (
        Index("ix_agent_run_events_run_seq", "run_id", "event_seq", unique=True),
        Index("ix_agent_run_events_project_created", "project_id", "created_at"),
    )

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    run_id: str = Field(foreign_key="agent_runs_v2.id", index=True)
    conversation_id: str | None = Field(default=None, index=True)
    workspace_id: str = Field(foreign_key="workspaces.id", index=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    type: RuntimeEventType = Field(index=True)
    event_seq: int = Field(index=True)
    client_event_id: str = Field(index=True)
    ordering_hint: int = Field(default=0)
    payload: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    trace: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def get_payload(self) -> dict | list:
        """Deserialize payload from stored JSON string."""
        return json.loads(self.payload)

    def set_payload(self, value: dict | list) -> None:
        """Serialize and store event payload."""
        self.payload = json.dumps(value, ensure_ascii=False)

    def get_trace(self) -> dict | list:
        """Deserialize trace from stored JSON string."""
        return json.loads(self.trace)

    def set_trace(self, value: dict | list) -> None:
        """Serialize and store event trace."""
        self.trace = json.dumps(value, ensure_ascii=False)


class AgentToolResource(SQLModel, table=True):
    """Durable, run-scoped payload for large tool results.

    Raw content is intentionally kept out of normal runtime events and traces.
    It is available only through authenticated, paginated internal endpoints.
    """
    __tablename__ = "agent_tool_resources"
    __table_args__ = (
        Index("ix_agent_tool_resources_run_created", "run_id", "created_at"),
        Index("ix_agent_tool_resources_tool_call", "run_id", "tool_call_id"),
    )

    id: str = Field(primary_key=True)
    run_id: str = Field(foreign_key="agent_runs_v2.id", index=True)
    workspace_id: str = Field(foreign_key="workspaces.id", index=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    tool_call_id: str = Field(index=True)
    tool_name: str = Field(index=True)
    content: str = Field(sa_column=Column(Text, nullable=False))
    content_type: str = Field(default="application/json")
    total_bytes: int = Field(ge=0)
    content_hash: str = Field(index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentRunStatePatch(SQLModel):
    """State patch submitted by sidecar via internal API."""
    schema_version: int = Field(default=1)
    status: AgentRunStatus | None = Field(default=None)
    current_turn: int | None = Field(default=None)
    current_step: int | None = Field(default=None)
    model_provider: str | None = Field(default=None)
    model_name: str | None = Field(default=None)
    pending_tool_call_id: str | None = Field(default=None)
    pending_tool_name: str | None = Field(default=None)
    pending_tool_version: int | None = Field(default=None)
    pending_idempotency_key: str | None = Field(default=None)
    last_event_seq: int | None = Field(default=None)
