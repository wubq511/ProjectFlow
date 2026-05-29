from sqlmodel import Session

from app.agent.llm_client import LLMClient, build_llm_client
from app.agent.modules import (
    active_push,
    assignment_negotiation,
    assignment_recommendation,
    breakdown,
    checkin_analysis,
    clarification,
    planning,
    replanning,
    risk_analysis,
)
from app.agent.modules.common import AgentModuleRequest
from app.agent.workflow import AgentRunResult, generate_structured_output
from app.schemas.workspace_state import WorkspaceStateResponse


class CoordinatorAgent:
    def __init__(self, *, llm_client: LLMClient | None = None, session: Session | None = None):
        self.llm_client = llm_client or build_llm_client()
        self.session = session

    def generate_direction_card(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, clarification.build_request(workspace_state))

    def generate_stage_plan(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, planning.build_request(workspace_state))

    def generate_task_breakdown(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, breakdown.build_request(workspace_state))

    def recommend_assignments(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, assignment_recommendation.build_request(workspace_state))

    def negotiate_assignment(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, assignment_negotiation.build_request(workspace_state))

    def create_active_push(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, active_push.build_request(workspace_state))

    def analyze_checkin(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, checkin_analysis.build_request(workspace_state))

    def analyze_risks(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, risk_analysis.build_request(workspace_state))

    def replan(self, workspace_state: WorkspaceStateResponse) -> AgentRunResult:
        return self._run(workspace_state, replanning.build_request(workspace_state))

    def _run(self, workspace_state: WorkspaceStateResponse, request: AgentModuleRequest) -> AgentRunResult:
        return generate_structured_output(
            session=self.session,
            workspace_state=workspace_state,
            event_type=request.event_type,
            llm_client=self.llm_client,
            user_prompt=request.user_prompt,
            fallback_payload=request.fallback_payload,
        )
