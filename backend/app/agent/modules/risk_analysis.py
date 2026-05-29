from app.agent.modules.common import AgentModuleRequest
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    return AgentModuleRequest(
        event_type=AgentEventType.risk,
        user_prompt="Analyze deadline, dependency, workload, scope, review, assignment, and check-in risks.",
        fallback_payload={
            "risks": [],
            "reason": "Fallback reports no new risk without concrete evidence.",
        },
    )
