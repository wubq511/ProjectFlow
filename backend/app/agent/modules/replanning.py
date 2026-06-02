from app.agent.modules.common import AgentModuleRequest
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    return AgentModuleRequest(
        event_type=AgentEventType.replan,
        user_prompt=(
            "Propose the smallest useful current-stage replan only if WorkspaceState shows blockers, overdue work, unassigned critical tasks, or workload mismatch. "
            "Use concise before/after/impact, cite specific task titles and member names (not IDs) as evidence, and keep requires_confirmation true. "
            "ALL user-facing text (impact, reason, stage_adjustments[*].reason, task_changes[*].reason) MUST be written in Chinese. "
            "Do not change finalized owners unless evidence clearly requires human-confirmed review."
        ),
        fallback_payload={
            "before": {"summary": "Keep the current plan unchanged."},
            "after": {"summary": "No automatic replan is applied."},
            "impact": "No schedule, ownership, or scope change is applied without confirmation.",
            "stage_adjustments": [],
            "task_changes": [],
            "action_cards": [],
            "requires_confirmation": True,
            "reason": "Fallback avoids changing the plan without stronger evidence.",
        },
    )
