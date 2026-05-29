from datetime import date

import pytest

from app.agent.output_schemas import (
    ActivePushOutput,
    AgentOutputValidationError,
    AssignmentNegotiationOutput,
    AssignmentRecommendationOutput,
    CheckInAnalysisOutput,
    DirectionCardOutput,
    ReplanOutput,
    RiskAnalysisOutput,
    StagePlanOutput,
    TaskBreakdownOutput,
    validate_agent_output,
)
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
            ),
            MemberState(
                user_id="user-2",
                display_name="Bob",
                skills=["frontend"],
                available_hours_per_week=6,
                role_preference="frontend",
                interests="UX",
                constraints="",
            ),
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
                    goal="Ship the demo loop",
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


@pytest.mark.parametrize(
    ("event_type", "payload", "expected_type"),
    [
        (
            AgentEventType.clarify,
            {
                "summary": "Scope needs one clarification.",
                "target_outcome": "Confirm MVP direction.",
                "constraints": ["Deadline is fixed"],
                "suggested_questions": ["Which demo path matters most?"],
                "reason": "The project deadline is near.",
            },
            DirectionCardOutput,
        ),
        (
            AgentEventType.plan,
            {
                "stages": [
                    {
                        "name": "MVP",
                        "goal": "Ship the demo loop",
                        "start_date": "2026-05-29",
                        "end_date": "2026-06-02",
                        "deliverable": "Runnable demo",
                        "done_criteria": ["API and frontend connected"],
                        "order_index": 0,
                        "reason": "This creates a usable path first.",
                    }
                ],
                "reason": "Stage plan keeps the deadline visible.",
            },
            StagePlanOutput,
        ),
        (
            AgentEventType.breakdown,
            {
                "tasks": [
                    {
                        "stage_id": "stage-1",
                        "title": "Build API",
                        "description": "Create deterministic endpoints.",
                        "priority": "P0",
                        "due_date": "2026-06-01",
                        "estimated_hours": 4,
                        "dependency_ids": [],
                        "acceptance_criteria": ["Smoke test passes"],
                        "can_cut": False,
                        "reason": "The agent needs stable state.",
                    }
                ],
                "reason": "Tasks map the stage into implementation work.",
            },
            TaskBreakdownOutput,
        ),
        (
            AgentEventType.assign,
            {
                "assignments": [
                    {
                        "task_id": "task-1",
                        "recommended_owner_user_id": "user-1",
                        "backup_owner_user_id": "user-2",
                        "reason": "Alice has backend skills.",
                        "risk_note": "Bob can cover frontend handoff.",
                    }
                ],
                "requires_confirmation": True,
                "reason": "Owners must confirm before finalization.",
            },
            AssignmentRecommendationOutput,
        ),
        (
            AgentEventType.negotiate,
            {
                "from_user_id": "user-1",
                "desired_task_id": "task-1",
                "current_owner_user_id": "user-2",
                "message": "Swap ownership if Bob agrees.",
                "options": ["Keep current owner", "Swap owner and backup"],
                "requires_confirmation": True,
                "reason": "A rejected assignment needs human agreement.",
            },
            AssignmentNegotiationOutput,
        ),
        (
            AgentEventType.push,
            {
                "action_cards": [
                    {
                        "type": "team_next_step",
                        "title": "Start API smoke path",
                        "content": "Create the first endpoint test.",
                        "reason": "It unblocks agent state reads.",
                        "user_id": "user-1",
                        "task_id": "task-1",
                        "stage_id": "stage-1",
                    }
                ],
                "reason": "The team needs one concrete next step.",
            },
            ActivePushOutput,
        ),
        (
            AgentEventType.checkin,
            {
                "summary": "API is moving, frontend is waiting.",
                "task_updates": [
                    {
                        "task_id": "task-1",
                        "user_id": "user-1",
                        "status": "in_progress",
                        "progress_note": "Models are ready.",
                        "blocker": None,
                    }
                ],
                "risks": [],
                "reason": "Check-in indicates partial progress.",
            },
            CheckInAnalysisOutput,
        ),
        (
            AgentEventType.risk,
            {
                "risks": [
                    {
                        "type": "deadline",
                        "severity": "medium",
                        "title": "Demo date is tight",
                        "description": "Only a few days remain.",
                        "evidence": [{"task_id": "task-1", "status": "not_started"}],
                        "recommendation": "Cut optional polish.",
                        "stage_id": "stage-1",
                        "task_id": "task-1",
                    }
                ],
                "reason": "Deadline risk is visible in current task status.",
            },
            RiskAnalysisOutput,
        ),
        (
            AgentEventType.replan,
            {
                "before": {"task-1": "Due 2026-06-01"},
                "after": {"task-1": "Due 2026-06-03"},
                "impact": "Moves the task by two days.",
                "stage_adjustments": [
                    {
                        "stage_id": "stage-1",
                        "new_end_date": "2026-06-03",
                        "reason": "Backend took longer than expected.",
                    }
                ],
                "task_changes": [
                    {
                        "task_id": "task-1",
                        "status": "in_progress",
                        "owner_user_id": "user-1",
                        "reason": "Keep ownership with the backend member.",
                    }
                ],
                "action_cards": [],
                "requires_confirmation": True,
                "reason": "Plan changes must be accepted by the team.",
            },
            ReplanOutput,
        ),
    ],
)
def test_validate_agent_output_accepts_expected_schema(event_type, payload, expected_type):
    output = validate_agent_output(event_type, payload, workspace_state=_workspace_state())

    assert isinstance(output, expected_type)
    assert output.reason


def test_validate_agent_output_fails_closed_when_required_fields_are_missing():
    with pytest.raises(AgentOutputValidationError):
        validate_agent_output(AgentEventType.clarify, {"summary": "Missing reason"})


def test_validate_agent_output_rejects_fabricated_task_or_member_references():
    with pytest.raises(AgentOutputValidationError) as exc_info:
        validate_agent_output(
            AgentEventType.assign,
            {
                "assignments": [
                    {
                        "task_id": "missing-task",
                        "recommended_owner_user_id": "missing-user",
                        "reason": "Fabricated references should fail.",
                    }
                ],
                "requires_confirmation": True,
                "reason": "Invalid IDs must be rejected.",
            },
            workspace_state=_workspace_state(),
        )

    assert "missing-task" in str(exc_info.value)
    assert "missing-user" in str(exc_info.value)


def test_high_severity_risk_requires_confirmation():
    with pytest.raises(AgentOutputValidationError):
        validate_agent_output(
            AgentEventType.risk,
            {
                "risks": [
                    {
                        "type": "deadline",
                        "severity": "high",
                        "title": "Demo likely misses deadline",
                        "description": "Critical path task is blocked.",
                        "evidence": [{"task_id": "task-1", "status": "blocked"}],
                        "recommendation": "Replan scope now.",
                    }
                ],
                "requires_confirmation": False,
                "reason": "High severity needs human confirmation.",
            },
        )


def test_replan_requires_confirmation():
    with pytest.raises(AgentOutputValidationError):
        validate_agent_output(
            AgentEventType.replan,
            {
                "before": {},
                "after": {},
                "impact": "No change should apply.",
                "stage_adjustments": [],
                "task_changes": [],
                "action_cards": [],
                "requires_confirmation": False,
                "reason": "Replan changes must not auto-apply.",
            },
        )
