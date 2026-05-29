from datetime import date

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent.coordinator import CoordinatorAgent
from app.agent.llm_client import MockLLMClient
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
from app.agent.output_schemas import validate_agent_output
from app.agent.workflow import AgentRunStatus
from app.models import AgentEvent
from app.models.enums import AgentEventType
from app.schemas.workspace_state import (
    MemberState,
    ProjectState,
    StageState,
    TaskState,
    WorkspaceStateResponse,
)


def _workspace_state() -> WorkspaceStateResponse:
    return WorkspaceStateResponse(
        workspace_id="workspace-1",
        workspace_name="Demo Team",
        members=[
            MemberState(
                user_id="user-1",
                display_name="Alice",
                skills=["backend"],
                available_hours_per_week=8,
                role_preference="backend",
                interests="APIs",
                constraints="",
            )
        ],
        project=ProjectState(
            id="project-1",
            name="Demo Project",
            idea="Build a project agent",
            deadline=date(2026, 6, 7),
            status="active",
            current_stage_id="stage-1",
            stages=[
                StageState(
                    id="stage-1",
                    name="MVP",
                    goal="Ship demo",
                    status="active",
                    order_index=0,
                )
            ],
            tasks=[
                TaskState(
                    id="task-1",
                    title="Build API",
                    status="not_started",
                    priority="P0",
                    owner_user_id=None,
                    due_date=date(2026, 6, 1),
                    can_cut=False,
                )
            ],
        ),
    )


@pytest.fixture(name="session")
def session_fixture():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


@pytest.mark.parametrize(
    ("module", "event_type"),
    [
        (clarification, AgentEventType.clarify),
        (planning, AgentEventType.plan),
        (breakdown, AgentEventType.breakdown),
        (assignment_recommendation, AgentEventType.assign),
        (assignment_negotiation, AgentEventType.negotiate),
        (active_push, AgentEventType.push),
        (checkin_analysis, AgentEventType.checkin),
        (risk_analysis, AgentEventType.risk),
        (replanning, AgentEventType.replan),
    ],
)
def test_agent_modules_return_valid_generation_requests(module, event_type):
    request = module.build_request(_workspace_state())

    assert request.event_type == event_type
    assert request.user_prompt
    validate_agent_output(
        request.event_type,
        request.fallback_payload,
        workspace_state=_workspace_state(),
    )


def test_coordinator_delegates_direction_card_generation_and_logs_event(session: Session):
    client = MockLLMClient(
        responses=[
            '{"summary":"Need direction","target_outcome":"Pick the demo path",'
            '"constraints":["Deadline is fixed"],'
            '"suggested_questions":["Which scope is required?"],'
            '"reason":"Direction must be explicit."}'
        ]
    )
    coordinator = CoordinatorAgent(llm_client=client, session=session)

    result = coordinator.generate_direction_card(_workspace_state())

    assert result.status == AgentRunStatus.success
    assert result.output.reason == "Direction must be explicit."
    assert client.calls == 1

    event = session.exec(select(AgentEvent)).one()
    assert event.event_type == AgentEventType.clarify
    assert event.output_snapshot["summary"] == "Need direction"


def test_coordinator_exposes_all_agent_flow_methods():
    coordinator = CoordinatorAgent(llm_client=MockLLMClient())

    assert callable(coordinator.generate_direction_card)
    assert callable(coordinator.generate_stage_plan)
    assert callable(coordinator.generate_task_breakdown)
    assert callable(coordinator.recommend_assignments)
    assert callable(coordinator.negotiate_assignment)
    assert callable(coordinator.create_active_push)
    assert callable(coordinator.analyze_checkin)
    assert callable(coordinator.analyze_risks)
    assert callable(coordinator.replan)
