from datetime import date, datetime

from pydantic import BaseModel

from app.models.enums import CheckInCycleStatus, MoodOrConfidence


class CheckInCycleCreate(BaseModel):
    project_id: str
    stage_id: str
    cadence_days: int = 2
    start_date: date
    created_by_user_id: str


class CheckInCycleRead(BaseModel):
    id: str
    project_id: str
    stage_id: str
    cadence_days: int
    start_date: date
    next_due_date: date
    status: CheckInCycleStatus
    created_by_user_id: str
    created_at: datetime


class CheckInResponseCreate(BaseModel):
    project_id: str
    stage_id: str
    user_id: str
    task_id: str | None = None
    what_done: str
    blocker: str | None = None
    available_hours_next_cycle: float | None = None
    mood_or_confidence: MoodOrConfidence | None = None


class CheckInResponseRead(BaseModel):
    id: str
    cycle_id: str
    project_id: str
    stage_id: str
    user_id: str
    task_id: str | None
    what_done: str
    blocker: str | None
    available_hours_next_cycle: float | None
    mood_or_confidence: MoodOrConfidence | None
    created_at: datetime
