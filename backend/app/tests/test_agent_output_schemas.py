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
                    stage_id="stage-1",
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
                "problem": "The project scope is not yet confirmed.",
                "users": "Student project team with mixed skills.",
                "value": "A clear direction card that enables staged planning.",
                "deliverables": ["Confirmed direction card", "Scope boundaries"],
                "boundaries": ["Deadline is fixed"],
                "risks": ["Scope creep without boundaries."],
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
        validate_agent_output(AgentEventType.clarify, {"problem": "Missing reason and other required fields"})


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


# ---------------------------------------------------------------------------
# Realistic messy project fixture
# ---------------------------------------------------------------------------

def _messy_workspace_state() -> WorkspaceStateResponse:
    """4 members, 3 stages, 6 tasks — mixed skills, blockers, overdue work."""
    return WorkspaceStateResponse(
        workspace_id="ws-messy",
        workspace_name="Hackathon Team",
        members=[
            MemberState(
                user_id="u-alice",
                display_name="Alice",
                skills=["backend", "database"],
                available_hours_per_week=10,
                role_preference="backend",
                interests="APIs and data modeling",
                constraints="Not available on weekends",
            ),
            MemberState(
                user_id="u-bob",
                display_name="Bob",
                skills=["frontend", "design"],
                available_hours_per_week=6,
                role_preference="frontend",
                interests="UI polish",
                constraints="Exam week — reduced hours",
            ),
            MemberState(
                user_id="u-carol",
                display_name="Carol",
                skills=["backend", "devops"],
                available_hours_per_week=8,
                role_preference="devops",
                interests="CI/CD and deployment",
                constraints="",
            ),
            MemberState(
                user_id="u-dan",
                display_name="Dan",
                skills=["frontend", "testing"],
                available_hours_per_week=12,
                role_preference="testing",
                interests="E2E testing",
                constraints="Prefers not to do design work",
            ),
        ],
        project=ProjectState(
            id="proj-hack",
            name="Campus Event Platform",
            idea="A platform for students to discover and register for campus events",
            deadline=date(2026, 6, 14),
            status="active",
            current_stage_id="stage-2",
            stages=[
                StageState(
                    id="stage-1",
                    name="Backend Foundation",
                    goal="API and database schema complete",
                    status="done",
                    order_index=0,
                ),
                StageState(
                    id="stage-2",
                    name="Frontend Integration",
                    goal="Connect UI to API, core user flows work",
                    status="active",
                    order_index=1,
                ),
                StageState(
                    id="stage-3",
                    name="Polish & Deploy",
                    goal="Testing, bug fixes, deployment",
                    status="not_started",
                    order_index=2,
                ),
            ],
            tasks=[
                TaskState(
                    id="task-api",
                    stage_id="stage-1",
                    title="Build event CRUD API",
                    status="done",
                    priority="P0",
                    owner_user_id="u-alice",
                    due_date=date(2026, 6, 1),
                    can_cut=False,
                ),
                TaskState(
                    id="task-db",
                    stage_id="stage-1",
                    title="Design database schema",
                    status="done",
                    priority="P0",
                    owner_user_id="u-alice",
                    due_date=date(2026, 5, 30),
                    can_cut=False,
                ),
                TaskState(
                    id="task-ui",
                    stage_id="stage-2",
                    title="Build event list page",
                    status="in_progress",
                    priority="P0",
                    owner_user_id="u-bob",
                    due_date=date(2026, 6, 5),
                    can_cut=False,
                ),
                TaskState(
                    id="task-auth",
                    stage_id="stage-2",
                    title="Add login flow",
                    status="not_started",
                    priority="P1",
                    owner_user_id=None,
                    due_date=date(2026, 6, 7),
                    can_cut=False,
                ),
                TaskState(
                    id="task-e2e",
                    stage_id="stage-2",
                    title="E2E test for registration",
                    status="not_started",
                    priority="P1",
                    owner_user_id=None,
                    due_date=date(2026, 6, 10),
                    can_cut=True,
                ),
                TaskState(
                    id="task-deploy",
                    stage_id="stage-2",
                    title="Set up CI/CD pipeline",
                    status="blocked",
                    priority="P0",
                    owner_user_id="u-carol",
                    due_date=date(2026, 6, 4),
                    can_cut=False,
                ),
            ],
        ),
    )


# ---------------------------------------------------------------------------
# Tests using messy fixture — representative model outputs
# ---------------------------------------------------------------------------


class TestDirectionCardWithMessyProject:
    def test_accepts_grounding_direction_card(self):
        output = validate_agent_output(
            AgentEventType.clarify,
            {
                "problem": "Campus events are scattered across WeChat groups and posters.",
                "users": "Students who want to discover and register for events.",
                "value": "One place to find and sign up for campus events.",
                "deliverables": ["Event listing page", "Registration form", "Login system"],
                "boundaries": ["No payment integration in MVP", "Admin panel deferred"],
                "risks": ["Bob has exam week — reduced frontend capacity", "CI/CD task is blocked"],
                "suggested_questions": [
                    "Should registration require login or be anonymous?",
                    "Is event approval needed before publishing?",
                ],
                "reason": "Direction card grounded in team availability and project deadline.",
            },
            workspace_state=_messy_workspace_state(),
        )
        assert isinstance(output, DirectionCardOutput)
        assert output.problem
        assert len(output.deliverables) >= 1


class TestPlanningWithMessyProject:
    def test_accepts_multi_stage_plan(self):
        output = validate_agent_output(
            AgentEventType.plan,
            {
                "stages": [
                    {
                        "name": "Backend Foundation",
                        "goal": "API and database schema complete",
                        "start_date": "2026-05-29",
                        "end_date": "2026-06-01",
                        "deliverable": "Working CRUD API with schema",
                        "done_criteria": ["All API endpoints return 200", "Schema matches spec"],
                        "order_index": 0,
                        "reason": "Alice has backend+database skills and 10h/week.",
                    },
                    {
                        "name": "Frontend Integration",
                        "goal": "Core user flows connected to API",
                        "start_date": "2026-06-02",
                        "end_date": "2026-06-07",
                        "deliverable": "Event list and registration pages",
                        "done_criteria": ["User can browse events", "User can register"],
                        "order_index": 1,
                        "reason": "Bob has frontend skills but reduced hours due to exams.",
                    },
                    {
                        "name": "Polish & Deploy",
                        "goal": "Testing, bug fixes, deployment",
                        "start_date": "2026-06-08",
                        "end_date": "2026-06-14",
                        "deliverable": "Deployed MVP",
                        "done_criteria": ["E2E tests pass", "Deployed to staging"],
                        "order_index": 2,
                        "reason": "Carol handles devops; Dan handles testing.",
                    },
                ],
                "reason": "Three stages match the project deadline and team skills.",
            },
            workspace_state=_messy_workspace_state(),
        )
        assert isinstance(output, StagePlanOutput)
        assert len(output.stages) == 3


class TestBreakdownWithMessyProject:
    def test_accepts_prioritized_task_breakdown(self):
        output = validate_agent_output(
            AgentEventType.breakdown,
            {
                "tasks": [
                    {
                        "stage_id": "stage-2",
                        "title": "Build event list page",
                        "description": "Fetch events from API and render in a list UI.",
                        "priority": "P0",
                        "due_date": "2026-06-05",
                        "estimated_hours": 6,
                        "dependency_ids": [],
                        "acceptance_criteria": ["Events load from API", "List is responsive"],
                        "can_cut": False,
                        "reason": "P0: core user flow. Bob has frontend skills.",
                    },
                    {
                        "stage_id": "stage-2",
                        "title": "Add login flow",
                        "description": "Implement OAuth or simple login.",
                        "priority": "P1",
                        "due_date": "2026-06-07",
                        "estimated_hours": 4,
                        "dependency_ids": [],
                        "acceptance_criteria": ["User can log in", "Session persists"],
                        "can_cut": False,
                        "reason": "P1: needed for registration but not for browsing.",
                    },
                    {
                        "stage_id": "stage-2",
                        "title": "Build registration form",
                        "description": "Allow users to sign up for events.",
                        "priority": "P1",
                        "due_date": "2026-06-06",
                        "estimated_hours": 4,
                        "dependency_ids": [],
                        "acceptance_criteria": ["Form submits to API", "Confirmation shown"],
                        "can_cut": True,
                        "reason": "P1 but can_cut: registration is valuable but not critical for demo.",
                    },
                ],
                "reason": "Tasks prioritize the event list (P0), then auth and registration (P1).",
            },
            workspace_state=_messy_workspace_state(),
        )
        assert isinstance(output, TaskBreakdownOutput)
        assert len(output.tasks) == 3
        # Verify can_cut is respected
        assert output.tasks[0].can_cut is False
        assert output.tasks[2].can_cut is True


class TestAssignmentWithMessyProject:
    def test_rejects_fabricated_member_in_assignment(self):
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(
                AgentEventType.assign,
                {
                    "assignments": [
                        {
                            "task_id": "task-auth",
                            "recommended_owner_user_id": "u-fabricated",
                            "reason": "This member does not exist.",
                        }
                    ],
                    "requires_confirmation": True,
                    "reason": "Should fail validation.",
                },
                workspace_state=_messy_workspace_state(),
            )
        assert "u-fabricated" in str(exc_info.value)


class TestRiskWithMessyProject:
    def test_accepts_evidence_grounded_risks(self):
        output = validate_agent_output(
            AgentEventType.risk,
            {
                "risks": [
                    {
                        "type": "deadline",
                        "severity": "high",
                        "title": "CI/CD task is blocked and overdue",
                        "description": "task-deploy is blocked and due 2026-06-04, which is past.",
                        "evidence": [{"task_id": "task-deploy", "status": "blocked", "due_date": "2026-06-04"}],
                        "recommendation": "Unblock the CI/CD task or reassign to another member.",
                        "stage_id": "stage-2",
                        "task_id": "task-deploy",
                    },
                    {
                        "type": "workload",
                        "severity": "medium",
                        "title": "Bob has reduced availability",
                        "description": "Bob has exam week constraints and only 6h/week.",
                        "evidence": [{"user_id": "u-bob", "available_hours_per_week": 6}],
                        "recommendation": "Consider Dan for frontend tasks to reduce Bob's load.",
                    },
                ],
                "requires_confirmation": True,
                "reason": "High severity deadline risk requires team attention.",
            },
            workspace_state=_messy_workspace_state(),
        )
        assert isinstance(output, RiskAnalysisOutput)
        assert len(output.risks) == 2

    def test_rejects_fabricated_task_id_in_evidence(self):
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(
                AgentEventType.risk,
                {
                    "risks": [
                        {
                            "type": "deadline",
                            "severity": "medium",
                            "title": "Fake risk",
                            "description": "Evidence references a fabricated task.",
                            "evidence": [{"task_id": "task-fabricated", "status": "blocked"}],
                            "recommendation": "Ignore.",
                        }
                    ],
                    "reason": "Evidence has fabricated ID.",
                },
                workspace_state=_messy_workspace_state(),
            )
        assert "task-fabricated" in str(exc_info.value)


class TestReplanWithMessyProject:
    def test_accepts_grounded_replan(self):
        output = validate_agent_output(
            AgentEventType.replan,
            {
                "before": {"task-deploy": "Due 2026-06-04, blocked"},
                "after": {"task-deploy": "Due 2026-06-08, unblocked"},
                "impact": "Delays deploy by 4 days but stays within project deadline.",
                "stage_adjustments": [
                    {
                        "stage_id": "stage-2",
                        "new_end_date": "2026-06-09",
                        "reason": "CI/CD unblock delayed; extend frontend stage.",
                    }
                ],
                "task_changes": [
                    {
                        "task_id": "task-deploy",
                        "due_date": "2026-06-08",
                        "reason": "Move deploy date after blocker is resolved.",
                    }
                ],
                "action_cards": [
                    {
                        "type": "team_next_step",
                        "title": "Resolve CI/CD blocker",
                        "content": "Carol needs to unblock the deploy task.",
                        "reason": "task-deploy is the critical path blocker.",
                        "user_id": "u-carol",
                        "task_id": "task-deploy",
                        "stage_id": "stage-2",
                    }
                ],
                "requires_confirmation": True,
                "reason": "Replan grounded in blocked task evidence and member availability.",
            },
            workspace_state=_messy_workspace_state(),
        )
        assert isinstance(output, ReplanOutput)
        assert len(output.stage_adjustments) == 1
        assert len(output.task_changes) == 1


# ---------------------------------------------------------------------------
# T23.B Assignment semantic validation tests
# ---------------------------------------------------------------------------


def _t23b_valid_assignment_output() -> dict:
    return {
        "assignments": [
            {
                "task_id": "task-auth",
                "recommended_owner_user_id": "u-alice",
                "backup_owner_user_id": "u-bob",
                "reason": "Alice has backend skills suitable for login flow.",
                "skill_match": "技能匹配：backend",
                "availability_match": "时间匹配：可用 10h/周",
                "preference_match": "偏好匹配：backend",
                "constraint_respected": "无明显冲突",
            },
            {
                "task_id": "task-e2e",
                "recommended_owner_user_id": "u-dan",
                "backup_owner_user_id": "u-bob",
                "reason": "Dan has testing skills and 12h/week.",
                "skill_match": "技能匹配：testing",
                "availability_match": "时间匹配：可用 12h/周",
                "preference_match": "偏好匹配：testing",
                "constraint_respected": "无明显冲突",
            },
        ],
        "requires_confirmation": True,
        "reason": "Assignments for stage-2 unassigned tasks.",
    }


class TestT23BAssignmentSemanticValidation:
    def test_accepts_valid_assignment_with_eligible_tasks(self):
        """Valid assignment for 2 unassigned tasks in active stage passes."""
        output = validate_agent_output(
            AgentEventType.assign,
            _t23b_valid_assignment_output(),
            workspace_state=_messy_workspace_state(),
        )
        assert isinstance(output, AssignmentRecommendationOutput)
        assert len(output.assignments) == 2

    def test_rejects_duplicate_task_id(self):
        payload = _t23b_valid_assignment_output()
        payload["assignments"].append(payload["assignments"][0])
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(
                AgentEventType.assign, payload,
                workspace_state=_messy_workspace_state(),
            )
        assert "duplicate task_id" in str(exc_info.value)

    def test_rejects_inactive_stage_task(self):
        """task-api is in stage-1 (done), not the active stage-2."""
        payload = _t23b_valid_assignment_output()
        payload["assignments"].append({
            "task_id": "task-api",
            "recommended_owner_user_id": "u-alice",
            "reason": "Should fail.",
        })
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(
                AgentEventType.assign, payload,
                workspace_state=_messy_workspace_state(),
            )
        assert "not in active stage" in str(exc_info.value)

    def test_rejects_done_task(self):
        payload = _t23b_valid_assignment_output()
        payload["assignments"].append({
            "task_id": "task-db",
            "recommended_owner_user_id": "u-alice",
            "reason": "Should fail.",
        })
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(
                AgentEventType.assign, payload,
                workspace_state=_messy_workspace_state(),
            )
        assert "already done" in str(exc_info.value)

    def test_rejects_task_with_owner(self):
        payload = _t23b_valid_assignment_output()
        payload["assignments"].append({
            "task_id": "task-ui",
            "recommended_owner_user_id": "u-bob",
            "reason": "Should fail.",
        })
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(
                AgentEventType.assign, payload,
                workspace_state=_messy_workspace_state(),
            )
        assert "already has owner" in str(exc_info.value)

    def test_rejects_owner_equals_backup(self):
        payload = _t23b_valid_assignment_output()
        payload["assignments"][0]["backup_owner_user_id"] = "u-alice"
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(
                AgentEventType.assign, payload,
                workspace_state=_messy_workspace_state(),
            )
        assert "must differ" in str(exc_info.value)

    def test_rejects_missing_eligible_tasks(self):
        """Must cover all eligible tasks in active stage."""
        payload = _t23b_valid_assignment_output()
        # Remove task-e2e so only task-auth remains — task-e2e is also eligible
        payload["assignments"] = [payload["assignments"][0]]
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(
                AgentEventType.assign, payload,
                workspace_state=_messy_workspace_state(),
            )
        assert "missing assignment" in str(exc_info.value)

    def test_accepts_empty_assignments_when_no_eligible_tasks(self):
        """A workspace state with all tasks blocked/done/finalized returns empty list allowed."""
        ws = _messy_workspace_state()
        if ws.project:
            for t in ws.project.tasks:
                t.status = "done"
        output = validate_agent_output(
            AgentEventType.assign,
            {"assignments": [], "requires_confirmation": True, "reason": "No eligible tasks."},
            workspace_state=ws,
        )
        assert isinstance(output, AssignmentRecommendationOutput)
        assert len(output.assignments) == 0


# ---------------------------------------------------------------------------
# T23.B IR1 — skill name normalization
# ---------------------------------------------------------------------------


class TestT23BSkillNameNormalization:
    """Skill names in user-facing text must use Chinese labels, not English underscores."""

    def test_normalizes_skill_names_in_user_facing_fields(self):
        ws = _messy_workspace_state()
        payload = _t23b_valid_assignment_output()
        # Inject raw English skill names
        payload["assignments"][0]["skill_match"] = "技能匹配：ai_ml等级4、prompt_engineering等级4、backend等级3"
        payload["assignments"][0]["availability_match"] = "时间匹配：可用 10h/周"
        payload["assignments"][0]["reason"] = "小赵的ai_ml和prompt_engineering技能完全匹配"

        output = validate_agent_output(
            AgentEventType.assign, payload, workspace_state=ws,
        )

        assert isinstance(output, AssignmentRecommendationOutput)
        a0 = output.assignments[0]
        assert a0.skill_match is not None
        assert "ai_ml" not in a0.skill_match, f"Should normalize ai_ml, got: {a0.skill_match}"
        assert "prompt_engineering" not in a0.skill_match, f"Should normalize prompt_engineering, got: {a0.skill_match}"
        assert "AI/ML" in a0.skill_match
        assert "Prompt 工程" in a0.skill_match
        assert "后端开发" in a0.skill_match
        assert a0.reason is not None
        assert "ai_ml" not in a0.reason
        assert "prompt_engineering" not in a0.reason
        assert "AI/ML" in a0.reason
        assert "Prompt 工程" in a0.reason

    def test_normalization_is_idempotent(self):
        """Already-Chinese field should not be corrupted by normalization."""
        ws = _messy_workspace_state()
        payload = _t23b_valid_assignment_output()
        payload["assignments"][0]["skill_match"] = "技能匹配：后端开发、AI/ML、Prompt 工程"

        output = validate_agent_output(
            AgentEventType.assign, payload, workspace_state=ws,
        )

        a0 = output.assignments[0]
        assert a0.skill_match is not None
        assert "后端开发" in a0.skill_match
        assert "AI/ML" in a0.skill_match
        assert "Prompt 工程" in a0.skill_match

# ---------------------------------------------------------------------------
# T23.B P0 — stage_id override validation
# ---------------------------------------------------------------------------


def _two_stage_workspace_state() -> WorkspaceStateResponse:
    return WorkspaceStateResponse(
        workspace_id='ws-stage-override',
        workspace_name='Stage Override Team',
        members=[
            MemberState(user_id='user-1', display_name='Alice', skills=['backend'], available_hours_per_week=10, role_preference='backend', interests='APIs', constraints=''),
            MemberState(user_id='user-2', display_name='Bob', skills=['frontend'], available_hours_per_week=8, role_preference='frontend', interests='UI', constraints=''),
        ],
        project=ProjectState(
            id='proj-override', name='Stage Override Project', idea='Test', deadline=date(2026,6,15), status='active', current_stage_id='stage-a',
            stages=[
                StageState(id='stage-a', name='Active', goal='Active', status='active', order_index=0),
                StageState(id='stage-b', name='Pending', goal='Future', status='pending', order_index=1),
            ],
            tasks=[
                TaskState(id='task-a', stage_id='stage-a', title='Active task', status='not_started', priority='P0', owner_user_id=None, due_date=date(2026,6,10), can_cut=False),
                TaskState(id='task-b', stage_id='stage-b', title='Pending task', status='not_started', priority='P1', owner_user_id=None, due_date=date(2026,6,12), can_cut=False),
            ],
        ),
    )


class TestT23BStageOverrideValidation:
    def test_rejects_task_from_non_current_stage_by_default(self):
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(AgentEventType.assign, {'assignments':[{'task_id':'task-b','recommended_owner_user_id':'user-1','reason':'Should fail.'}],'requires_confirmation':True,'reason':'Testing.'}, workspace_state=_two_stage_workspace_state())
        assert 'not in active stage' in str(exc_info.value)

    def test_accepts_task_when_current_stage_id_is_overridden(self):
        ws = _two_stage_workspace_state()
        if ws.project:
            ws.project.current_stage_id = 'stage-b'
        output = validate_agent_output(AgentEventType.assign, {'assignments':[{'task_id':'task-b','recommended_owner_user_id':'user-1','backup_owner_user_id':'user-2','reason':'Alice has skills.'}],'requires_confirmation':True,'reason':'Override.'}, workspace_state=ws)
        assert isinstance(output, AssignmentRecommendationOutput)
        assert len(output.assignments) == 1
        assert output.assignments[0].task_id == 'task-b'

    def test_override_covers_all_eligible_tasks_in_target_stage(self):
        ws = _two_stage_workspace_state()
        if ws.project:
            ws.project.tasks.append(TaskState(id='task-b2', stage_id='stage-b', title='Second', status='not_started', priority='P2', owner_user_id=None, due_date=date(2026,6,14), can_cut=False))
            ws.project.current_stage_id = 'stage-b'
        with pytest.raises(AgentOutputValidationError) as exc_info:
            validate_agent_output(AgentEventType.assign, {'assignments':[{'task_id':'task-b','recommended_owner_user_id':'user-1','reason':'Missing.'}],'requires_confirmation':True,'reason':'Should fail.'}, workspace_state=ws)
        assert 'missing assignment' in str(exc_info.value)
