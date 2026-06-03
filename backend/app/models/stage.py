import uuid

from sqlmodel import SQLModel, Field


class Stage(SQLModel, table=True):
    __tablename__ = "stages"

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="projects.id")
    name: str
    goal: str
    start_date: str  # ISO date string
    end_date: str  # ISO date string
    deliverable: str
    done_criteria: str = Field(default="[]")  # JSON string: ["criterion1", ...]
    status: str = Field(default="pending")  # "pending" | "active" | "completed" | "at_risk"
    order_index: int = Field(default=0)
