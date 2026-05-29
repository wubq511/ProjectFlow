from dataclasses import dataclass
from datetime import date
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
