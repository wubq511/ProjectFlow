from app.agent.modules.common import AgentModuleRequest
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    return AgentModuleRequest(
        event_type=AgentEventType.replan,
        user_prompt="Propose a safe replan using only known stages, tasks, and members.",
        fallback_payload={
            "stage_adjustments": [],
            "task_changes": [],
            "action_cards": [],
            "requires_confirmation": True,
            "reason": "Fallback avoids changing the plan without stronger evidence.",
        },
    )
