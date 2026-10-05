import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, JSON
from sqlmodel import SQLModel, Field


class Risk(SQLModel, table=True):
    __tablename__ = "risks"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    stage_id: str | None = Field(default=None, foreign_key="stages.id", index=True)
    task_id: str | None = Field(default=None, foreign_key="tasks.id", index=True)
    type: str = Field(index=True)  # "deadline" | "dependency" | "workload" | "scope" | "review" | "assignment" | "checkin"
    severity: str  # "low" | "medium" | "high"
    title: str
    description: str
    evidence: str = Field(default="[]")  # JSON string: ["evidence1", ...]
    evidence_refs: list[dict] = Field(
        default_factory=list,
        sa_column=Column(JSON, nullable=False),
    )
    recommendation: str
    status: str = Field(default="open", index=True)  # "open" | "accepted" | "ignored" | "resolved"
    created_by_agent: bool = Field(default=False)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
