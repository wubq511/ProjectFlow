from app.agent.modules.common import AgentModuleRequest, first_stage_id, project_deadline_or_today
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    stage_id = first_stage_id(workspace_state)
    return AgentModuleRequest(
        event_type=AgentEventType.breakdown,
        user_prompt="Break the current stage into prioritized implementation tasks.",
        fallback_payload={
            "tasks": [
                {
                    "stage_id": stage_id,
                    "title": "Confirm next implementation step",
                    "description": "Identify the smallest task that moves the MVP forward.",
                    "priority": "P0",
                    "due_date": project_deadline_or_today(workspace_state).isoformat(),
                    "estimated_hours": 1,
                    "dependency_ids": [],
                    "acceptance_criteria": ["The next step is explicit and actionable."],
                    "can_cut": False,
                    "reason": "Fallback avoids fabricating a detailed backlog.",
                }
            ],
            "reason": "Template fallback produces one conservative task proposal.",
        },
    )
