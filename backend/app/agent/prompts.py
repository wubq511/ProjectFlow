from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


AGENT_SYSTEM_PROMPT = """You are ProjectFlow's single Coordinator Agent.
Return only one JSON object matching the requested schema.
Do not fabricate members, tasks, stages, assignments, projects, or IDs.
Use only entities present in the supplied WorkspaceState.
Every recommendation must include a concise reason.
High-risk suggestions must set requires_confirmation to true.
Agent output is a proposal only; services finalize state changes after human confirmation."""


def build_prompt_messages(
    *,
    event_type: AgentEventType,
    workspace_state: WorkspaceStateResponse,
    user_prompt: str,
) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": AGENT_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Event type: {event_type.value}\n"
                f"WorkspaceState JSON:\n{workspace_state.model_dump_json()}\n\n"
                f"Task:\n{user_prompt}"
            ),
        },
    ]
