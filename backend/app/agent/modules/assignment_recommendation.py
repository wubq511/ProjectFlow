from app.agent.modules.common import AgentModuleRequest, first_member_id, first_task_id
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    member_id = first_member_id(workspace_state)
    task_id = first_task_id(workspace_state)
    return AgentModuleRequest(
        event_type=AgentEventType.assign,
        user_prompt="Recommend task owners using only known members and tasks.",
        fallback_payload={
            "assignments": [
                {
                    "task_id": task_id,
                    "recommended_owner_user_id": member_id,
                    "backup_owner_user_id": None,
                    "reason": "This is the first available member and must be confirmed.",
                    "risk_note": "Fallback assignment is conservative and needs human review.",
                }
            ],
            "requires_confirmation": True,
            "reason": "Assignments must remain proposals until the team confirms them.",
        },
    )
