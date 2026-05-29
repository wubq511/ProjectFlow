from datetime import date
from typing import Any

from pydantic import BaseModel

from app.models.enums import TaskStatus
from app.schemas.action_card import ActionCardCreate


class ReplanStageAdjustment(BaseModel):
    stage_id: str
    new_start_date: date | None = None
    new_end_date: date | None = None
    reason: str


class ReplanTaskChange(BaseModel):
    task_id: str
    title: str | None = None
    status: TaskStatus | None = None
    owner_user_id: str | None = None
    due_date: date | None = None
    can_cut: bool | None = None
    reason: str


class ReplanConfirmRequest(BaseModel):
    project_id: str
    before: dict[str, Any] | list | str
    after: dict[str, Any] | list | str
    impact: str
    reason: str
    requires_confirmation: bool
    stage_adjustments: list[ReplanStageAdjustment] = []
    task_changes: list[ReplanTaskChange] = []
    action_cards: list[ActionCardCreate] = []


class ReplanConfirmRead(BaseModel):
    confirmed: bool
    project_id: str
    before: dict[str, Any] | list | str
    after: dict[str, Any] | list | str
    impact: str
    reason: str
    requires_confirmation: bool
    applied_stage_ids: list[str]
    applied_task_ids: list[str]
    created_action_card_ids: list[str]
