from app.agent.modules.common import AgentModuleRequest, first_member_id, first_stage_id, first_task_id
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    return AgentModuleRequest(
        event_type=AgentEventType.push,
        user_prompt="Create active push action cards that move the team forward.",
        fallback_payload={
            "action_cards": [
                {
                    "type": "team_next_step",
                    "title": "Confirm next action",
                    "content": "Pick the smallest useful next step for the active stage.",
                    "reason": "Fallback should prompt action without inventing work.",
                    "user_id": first_member_id(workspace_state),
                    "stage_id": first_stage_id(workspace_state),
                    "task_id": first_task_id(workspace_state),
                }
            ],
            "reason": "Active push fallback keeps the team focused on one action.",
        },
    )
