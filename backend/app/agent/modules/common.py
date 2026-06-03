from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.models.enums import AgentEventType
from app.schemas.workspace_state import (
    MemberState,
    TaskState,
    WorkspaceStateResponse,
)


# Statuses that block a task from receiving new proposals
TERMINAL_ASSIGNMENT_STATUSES = {"finalized", "owner_confirmed", "proposed", "negotiating"}

# Skill name → Chinese display label mapping for user-facing text normalization
SKILL_NAME_CN_MAP: dict[str, str] = {
    "ai_ml": "AI/ML",
    "prompt_engineering": "Prompt 工程",
    "backend": "后端开发",
    "frontend": "前端开发",
    "database": "数据库",
    "devops": "DevOps",
    "design": "UI 设计",
    "animation": "动效设计",
    "testing": "测试",
    "documentation": "文档",
    "project_management": "项目管理",
    "presentation": "演示汇报",
}


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


# ---------------------------------------------------------------------------
# Assignment helpers — used by assignment_recommendation and output validation
# ---------------------------------------------------------------------------


def active_stage_id(workspace_state: WorkspaceStateResponse) -> str | None:
    if not workspace_state.project:
        return None
    if workspace_state.project.current_stage_id:
        return workspace_state.project.current_stage_id
    active = next((stage for stage in workspace_state.project.stages if stage.status == "active"), None)
    return active.id if active else None


def rejected_assignment_pairs(workspace_state: WorkspaceStateResponse) -> set[tuple[str, str]]:
    if not workspace_state.project:
        return set()
    return {
        (proposal.task_id, proposal.recommended_owner_user_id)
        for proposal in workspace_state.project.assignment_proposals
        if proposal.status == "owner_rejected"
    }


def blocked_assignment_task_ids(workspace_state: WorkspaceStateResponse) -> set[str]:
    if not workspace_state.project:
        return set()
    return {
        proposal.task_id
        for proposal in workspace_state.project.assignment_proposals
        if proposal.status in TERMINAL_ASSIGNMENT_STATUSES
    }


def assignable_tasks(workspace_state: WorkspaceStateResponse, *, stage_id: str | None = None) -> list[TaskState]:
    stage_id = stage_id or active_stage_id(workspace_state)
    if not workspace_state.project or not stage_id:
        return []
    blocked_task_ids = blocked_assignment_task_ids(workspace_state)
    return [
        task
        for task in workspace_state.project.tasks
        if task.stage_id == stage_id
        and task.status != "done"
        and not task.owner_user_id
        and task.id not in blocked_task_ids
    ]


def score_member_for_task(
    member: MemberState,
    task: TaskState,
    assigned_count: int = 0,
) -> int:
    """Simple scoring: higher = better match for this task.

    Rules:
    - Task title/description keywords matching member skills: +3 per keyword.
    - role_preference or interests matching task keywords: +1 per content word (>2 chars).
    - available_hours >= estimated_hours: +2; otherwise +1 (some time better than none).
    - constraints mention conflicting keywords: -2.
    - Each already-assigned task in this round reduces score by 1 (load balancing).
    """
    score = 0
    task_text = f"{task.title} {task.description}".lower()

    # Skill match: +3 per matching keyword
    for skill in member.skills:
        skill_str = str(skill).lower()
        if skill_str in task_text:
            score += 3

    # Preference / interest match: +2
    pref_text = f"{member.role_preference} {member.interests}".lower()
    for word in task_text.split():
        if word in pref_text and len(word) > 2:
            score += 1  # one point per matching content word over 2 chars

    # Availability match
    if member.available_hours_per_week >= task.estimated_hours:
        score += 2
    elif task.estimated_hours > 0:
        score += 1  # partial availability is better than none

    # Constraint check
    if member.constraints:
        conflict_keywords = [
            "not", "avoid", "can't", "unavailable", "prefers not",
            "不可用", "不能", "避免", "不想", "不愿意", "没空", "冲突",
        ]
        constraint_lower = member.constraints.lower()
        for kw in conflict_keywords:
            if kw in constraint_lower:
                score -= 2
                break

    # Load balancing: already-assigned tasks reduce score
    score -= assigned_count

    return score
