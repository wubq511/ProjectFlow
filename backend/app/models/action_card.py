import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, JSON
from sqlmodel import SQLModel, Field


class ActionCard(SQLModel, table=True):
    __tablename__ = "action_cards"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    stage_id: str | None = Field(default=None, foreign_key="stages.id", index=True)
    user_id: str | None = Field(default=None, foreign_key="users.id", index=True)
    task_id: str | None = Field(default=None, foreign_key="tasks.id", index=True)
    type: str  # "personal_task" | "team_next_step" | "reminder" | "risk_action" | "kickoff_tip" | "checkin_prompt" | "assignment_request"
    title: str
    content: str
    reason: str
    goal: str | None = Field(default=None)
    start_suggestion: str | None = Field(default=None)
    completion_standard: str | None = Field(default=None)
    due_date: str | None = Field(default=None)  # ISO date string
    evidence_refs: list[dict] = Field(
        default_factory=list,
        sa_column=Column(JSON, nullable=False),
    )
    status: str = Field(default="active", index=True)  # "active" | "done" | "dismissed"
    created_by_agent: bool = Field(default=False)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
