from datetime import date
from pydantic import BaseModel

from app.models.enums import StageStatus


class StageCreate(BaseModel):
    project_id: str
    name: str
    goal: str
    start_date: date
    end_date: date
    deliverable: str
    done_criteria: dict | list | None = None
    order_index: int | None = None


class StageUpdate(BaseModel):
    name: str | None = None
    goal: str | None = None
    status: StageStatus | None = None
    order_index: int | None = None


class StageRead(BaseModel):
    id: str
    project_id: str
    name: str
    goal: str
    start_date: date
    end_date: date
    deliverable: str
    done_criteria: dict | list
    status: StageStatus
    order_index: int
