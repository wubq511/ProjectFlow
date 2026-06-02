from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


@dataclass(frozen=True)
class AgentModuleRequest:
    event_type: AgentEventType
    user_prompt: str
    fallback_payload: dict[str, Any]


def project_deadline_or_today(workspace_state: WorkspaceStateResponse) -> date:
    if workspace_state.project:
        return workspace_state.project.deadline
    return date.today()


def project_name_or_default(workspace_state: WorkspaceStateResponse) -> str:
    if workspace_state.project and workspace_state.project.name:
        return workspace_state.project.name
    return "当前项目"


def project_idea_or_default(workspace_state: WorkspaceStateResponse) -> str:
    if workspace_state.project and workspace_state.project.idea:
        return workspace_state.project.idea
    return "团队已经有初步想法，但还需要收敛成可执行范围"


def first_stage_name_or_default(workspace_state: WorkspaceStateResponse) -> str:
    if workspace_state.project and workspace_state.project.stages:
        return workspace_state.project.stages[0].name
    return "当前阶段"


def stage_windows(start: date, end: date, preferred_count: int = 3) -> list[tuple[date, date]]:
    if end < start:
        end = start
    total_days = (end - start).days + 1
    count = min(preferred_count, max(1, total_days))
    windows: list[tuple[date, date]] = []
    cursor = start
    for index in range(count):
        remaining_days = (end - cursor).days + 1
        remaining_slots = count - index
        span = max(1, (remaining_days + remaining_slots - 1) // remaining_slots)
        window_end = min(end, cursor + timedelta(days=span - 1))
        windows.append((cursor, window_end))
        cursor = window_end + timedelta(days=1)
    return windows


def first_stage_id(workspace_state: WorkspaceStateResponse) -> str | None:
    if workspace_state.project and workspace_state.project.stages:
        return workspace_state.project.stages[0].id
    return None


def first_task_id(workspace_state: WorkspaceStateResponse) -> str | None:
    if workspace_state.project and workspace_state.project.tasks:
        return workspace_state.project.tasks[0].id
    return None


def first_member_id(workspace_state: WorkspaceStateResponse) -> str | None:
    if workspace_state.members:
        return workspace_state.members[0].user_id
    return None
