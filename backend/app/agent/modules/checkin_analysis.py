from app.agent.modules.common import AgentModuleRequest, first_member_id, first_task_id
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    return AgentModuleRequest(
        event_type=AgentEventType.checkin,
        user_prompt="Analyze check-in signals for task progress and blockers.",
        fallback_payload={
            "summary": "No strong check-in signal is available.",
            "task_updates": [
                {
                    "task_id": first_task_id(workspace_state),
                    "user_id": first_member_id(workspace_state),
                    "status": "not_started",
                    "progress_note": "Fallback keeps current task state unchanged.",
                    "blocker": None,
                }
            ],
            "risks": [],
            "reason": "Fallback should avoid inventing progress.",
        },
    )
