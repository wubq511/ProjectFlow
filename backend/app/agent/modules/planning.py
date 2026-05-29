from datetime import date

from app.agent.modules.common import AgentModuleRequest, project_deadline_or_today
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    start = date.today()
    deadline = project_deadline_or_today(workspace_state)
    end = deadline if deadline >= start else start
    return AgentModuleRequest(
        event_type=AgentEventType.plan,
        user_prompt="Create an explainable stage plan for the current project.",
        fallback_payload={
            "stages": [
                {
                    "name": "MVP Demo",
                    "goal": "Produce the smallest demoable project loop.",
                    "start_date": start.isoformat(),
                    "end_date": end.isoformat(),
                    "deliverable": "A runnable ProjectFlow MVP path.",
                    "done_criteria": ["The team can inspect a concrete next step."],
                    "order_index": 0,
                    "reason": "The fallback keeps the plan scoped to the demo deadline.",
                }
            ],
            "reason": "Template fallback avoids fabricating detailed stages.",
        },
    )
