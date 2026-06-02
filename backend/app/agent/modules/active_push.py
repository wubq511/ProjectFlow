from app.agent.modules.common import AgentModuleRequest, first_member_id, first_stage_id, first_task_id
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    fallback_member = workspace_state.members[0] if workspace_state.members else None
    fallback_member_name = fallback_member.display_name if fallback_member else "team"
    fallback_stage = None
    fallback_task_title = "next task"
    if workspace_state.project and workspace_state.project.stages:
        fallback_stage = workspace_state.project.stages[0]
    if workspace_state.project and workspace_state.project.tasks:
        for t in workspace_state.project.tasks:
            if t.status != "done":
                fallback_task_title = t.title
                break

    member_id = first_member_id(workspace_state)
    stage_id = first_stage_id(workspace_state)
    task_id = first_task_id(workspace_state)

    if member_id is None or stage_id is None or task_id is None:
        return AgentModuleRequest(
            event_type=AgentEventType.push,
            user_prompt=(
                "Create exactly 1 action card for the most important next step. "
                "Prefer blocked, overdue, unassigned, or high-priority tasks. "
                "Each card needs goal, start_suggestion, completion_standard, and a reason citing task status, deadline, or member capacity."
            ),
            fallback_payload={
                "action_cards": [],
                "reason": "No members, stages, or tasks available for active push.",
            },
        )

    return AgentModuleRequest(
        event_type=AgentEventType.push,
        user_prompt=(
            "Create exactly 1 action card for the most important next step. "
            "Prefer blocked, overdue, unassigned, or high-priority tasks. "
            "Each card needs goal, start_suggestion, completion_standard, and a reason citing task status, deadline, or member capacity. "
            "ALL text fields (title, content, reason, goal, start_suggestion, completion_standard) MUST be written in Chinese. "
            "In text fields, use member display names (e.g. '小林') and task titles (e.g. '后端 API') — never use raw IDs."
        ),
        fallback_payload={
            "action_cards": [
                {
                    "type": "team_next_step",
                    "title": f"Confirm next action: {fallback_task_title}",
                    "content": f"Pick the smallest useful next step for the active stage.",
                    "reason": f"Fallback: {fallback_member_name} should take the next actionable step.",
                    "goal": f"Advance {fallback_task_title} to in_progress",
                    "start_suggestion": f"Start working on {fallback_task_title}",
                    "completion_standard": f"{fallback_task_title} is marked done or in_progress",
                    "stage_id": stage_id,
                    "task_id": task_id,
                }
            ],
            "reason": "Active push fallback keeps the team focused on one action.",
        },
    )
