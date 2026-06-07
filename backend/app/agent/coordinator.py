from sqlmodel import Session
from dataclasses import replace

from app.agent.llm_client import LLMClient, build_agent_llm_client
from app.agent.modules import (
    active_push,
    assignment_negotiation,
    assignment_recommendation,
    breakdown,
    checkin_analysis,
    clarification,
    planning,
    replanning,
    retrospective,
    risk_analysis,
)
from app.agent.modules.common import AgentModuleRequest
from app.agent.workflow import AgentRunResult, generate_structured_output
from app.schemas.workspace_state import WorkspaceStateResponse


class CoordinatorAgent:
    def __init__(self, *, llm_client: LLMClient | None = None, session: Session | None = None):
        self.llm_client = llm_client or build_agent_llm_client()
        self.session = session

    def generate_direction_card(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            clarification.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def generate_stage_plan(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            planning.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def generate_task_breakdown(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            breakdown.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def recommend_assignments(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        stage_id: str | None = None,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        # When targeting a non-active stage, override current_stage_id on a copy
        # so that validate_agent_output enforces rules against the correct stage.
        if stage_id and workspace_state.project:
            workspace_state = workspace_state.model_copy(deep=True)
            workspace_state.project.current_stage_id = stage_id
        return self._run(
            workspace_state,
            assignment_recommendation.build_request(workspace_state, stage_id=stage_id),
            user_instruction=user_instruction,
        )

    def negotiate_assignment(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            assignment_negotiation.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def create_active_push(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            active_push.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def analyze_checkin(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            checkin_analysis.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def analyze_risks(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            risk_analysis.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def replan(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            replanning.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def generate_retrospective(
        self,
        workspace_state: WorkspaceStateResponse,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        return self._run(
            workspace_state,
            retrospective.build_request(workspace_state),
            user_instruction=user_instruction,
        )

    def _run(
        self,
        workspace_state: WorkspaceStateResponse,
        request: AgentModuleRequest,
        *,
        user_instruction: str | None = None,
    ) -> AgentRunResult:
        if user_instruction:
            request = replace(request, user_instruction=user_instruction)
        return generate_structured_output(
            session=self.session,
            workspace_state=workspace_state,
            event_type=request.event_type,
            llm_client=self.llm_client,
            user_prompt=request.user_prompt,
            fallback_payload=request.fallback_payload,
            user_instruction=request.user_instruction,
        )
