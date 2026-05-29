from app.agent.modules.common import AgentModuleRequest
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    return AgentModuleRequest(
        event_type=AgentEventType.clarify,
        user_prompt=(
            "Create a direction card that identifies missing project information "
            "and asks only the most useful clarification questions."
        ),
        fallback_payload={
            "summary": "The project needs one explicit next decision.",
            "target_outcome": "Confirm the next useful planning step.",
            "constraints": ["Use only the supplied WorkspaceState."],
            "suggested_questions": ["What is the next decision the team must confirm?"],
            "reason": "A safe fallback should ask for clarification instead of inventing state.",
        },
    )
