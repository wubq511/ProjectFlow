"""Issue #20: Assignment, Push, Risk, and Replan Usability Pass.

Tests for:
- Assignment reasons cite member skill, availability, preference, or constraint
- Active push cards include goal, start_suggestion, completion_standard, due_date, reason
- Risk cards include evidence from task status, check-in, workload, dependency, deadline
- Replan proposals include before/after, impact, reason, and explicit confirmation requirement
- High-risk suggestions do not directly modify finalized task ownership
- Blocker + availability-drop scenario using real schema-shaped Agent output
"""

from datetime import date

import json
import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.agent.output_schemas import (
    ActivePushOutput,
    AssignmentRecommendationOutput,
    ReplanOutput,
    RiskAnalysisOutput,
    validate_agent_output,
)
from app.models import Project, Stage, Task, User
from app.models.enums import AgentEventType, AssignmentProposalStatus
from app.schemas.assignment import AssignmentProposalCreate
from app.schemas.replan import ReplanConfirmRequest, ReplanTaskChange
from app.schemas.workspace_state import (
    MemberState,
    ProjectState,
    StageState,
    TaskState,
    WorkspaceStateResponse,
)
from app.services.assignment_service import create_assignment_proposal, finalize_assignment_proposal
from app.services.replan_service import confirm_replan


# ---------------------------------------------------------------------------
# Fixture: blocker + availability-drop scenario
# ---------------------------------------------------------------------------

def _blocked_availability_drop_state() -> WorkspaceStateResponse:
    """Scenario: task-deploy is blocked, Bob's availability dropped from 10 to 3h/week."""
    return WorkspaceStateResponse(
        workspace_id="ws-blocker",
        workspace_name="Stuck Team",
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
                available_hours_per_week=3,  # Dropped from 10
                role_preference="frontend",
                interests="UI polish",
                constraints="Exam week — reduced hours",
            ),
        ],
        project=ProjectState(
            id="proj-blocker",
            name="Campus Event Platform",
            idea="A platform for students to discover campus events",
            deadline=date(2026, 6, 14),
            status="active",
            current_stage_id="stage-build",
            stages=[
                StageState(
                    id="stage-build",
                    name="Build",
                    goal="Core features complete",
                    status="active",
                    order_index=0,
                ),
            ],
            tasks=[
                TaskState(
                    id="task-api",
                    stage_id="stage-build",
                    title="Build event API",
                    status="in_progress",
                    priority="P0",
                    owner_user_id="u-alice",
                    due_date=date(2026, 6, 5),
                    can_cut=False,
                ),
                TaskState(
                    id="task-deploy",
                    stage_id="stage-build",
                    title="Set up CI/CD pipeline",
                    status="blocked",
                    priority="P0",
                    owner_user_id="u-bob",
                    due_date=date(2026, 6, 4),
                    can_cut=False,
                ),
                TaskState(
                    id="task-ui",
                    stage_id="stage-build",
                    title="Build event list page",
                    status="not_started",
                    priority="P0",
                    owner_user_id=None,
                    due_date=date(2026, 6, 7),
                    can_cut=False,
                ),
            ],
        ),
    )


# ---------------------------------------------------------------------------
# Test: Assignment reasons cite skill, availability, preference, constraint
# ---------------------------------------------------------------------------

class TestAssignmentCitations:
    def test_assignment_with_structured_citations_passes_validation(self):
        """Assignment recommendation with skill_match, availability_match,
        preference_match, constraint_respected passes schema validation."""
        output = validate_agent_output(
            AgentEventType.assign,
            {
                "assignments": [
                    {
                        "task_id": "task-ui",
                        "recommended_owner_user_id": "u-bob",
                        "backup_owner_user_id": "u-alice",
                        "reason": "Bob has frontend skills and the task is UI work.",
                        "skill_match": "Bob has frontend skill matching UI task",
                        "availability_match": "Bob has 3h/week — tight for 6h task, needs monitoring",
                        "preference_match": "Bob role_preference is frontend, aligns with UI work",
                        "constraint_respected": "Bob has exam week constraint — limited hours acknowledged",
                        "risk_note": "Bob's reduced availability may delay this task.",
                    }
                ],
                "requires_confirmation": True,
                "reason": "Assignment cites skill, availability, preference, and constraint.",
            },
            workspace_state=_blocked_availability_drop_state(),
        )
        assert isinstance(output, AssignmentRecommendationOutput)
        assignment = output.assignments[0]
        assert assignment.skill_match is not None
        assert "前端开发" in assignment.skill_match
        assert assignment.availability_match is not None
        assert assignment.preference_match is not None
        assert "前端开发" in assignment.preference_match
        assert assignment.constraint_respected is not None

    def test_assignment_without_citations_still_valid(self):
        """Citation fields are optional — old-format assignments still work."""
        output = validate_agent_output(
            AgentEventType.assign,
            {
                "assignments": [
                    {
                        "task_id": "task-ui",
                        "recommended_owner_user_id": "u-bob",
                        "reason": "Bob has frontend skills.",
                    }
                ],
                "requires_confirmation": True,
                "reason": "Basic assignment without structured citations.",
            },
            workspace_state=_blocked_availability_drop_state(),
        )
        assert isinstance(output, AssignmentRecommendationOutput)
        assert output.assignments[0].skill_match is None


# ---------------------------------------------------------------------------
# Test: Active push cards include goal, start_suggestion, completion_standard
# ---------------------------------------------------------------------------

class TestActivePushCardFields:
    def test_push_card_with_goal_and_suggestions_passes_validation(self):
        """Active push card with goal, start_suggestion, completion_standard
        passes schema validation."""
        output = validate_agent_output(
            AgentEventType.push,
            {
                "action_cards": [
                    {
                        "type": "risk_action",
                        "title": "Unblock CI/CD pipeline",
                        "content": "The deploy task is blocked and on the critical path.",
                        "reason": "task-deploy is blocked and due 2026-06-04.",
                        "goal": "Unblock the CI/CD pipeline so deployment can proceed",
                        "start_suggestion": "Resolve the missing deployment config in deploy.yml",
                        "completion_standard": "CI pipeline runs green on main branch",
                        "user_id": "u-bob",
                        "task_id": "task-deploy",
                        "stage_id": "stage-build",
                        "due_date": "2026-06-04",
                    }
                ],
                "reason": "Blocked task needs immediate attention.",
            },
            workspace_state=_blocked_availability_drop_state(),
        )
        assert isinstance(output, ActivePushOutput)
        card = output.action_cards[0]
        assert card.goal is not None
        assert "Unblock" in card.goal
        assert card.start_suggestion is not None
        assert card.completion_standard is not None
        assert card.due_date is not None

    def test_push_card_without_optional_fields_still_valid(self):
        """goal, start_suggestion, completion_standard are optional."""
        output = validate_agent_output(
            AgentEventType.push,
            {
                "action_cards": [
                    {
                        "type": "team_next_step",
                        "title": "Start UI work",
                        "content": "Pick up the event list page.",
                        "reason": "task-ui is unassigned and P0.",
                        "user_id": "u-bob",
                        "task_id": "task-ui",
                        "stage_id": "stage-build",
                    }
                ],
                "reason": "Team needs to start UI work.",
            },
            workspace_state=_blocked_availability_drop_state(),
        )
        assert isinstance(output, ActivePushOutput)
        assert output.action_cards[0].goal is None


# ---------------------------------------------------------------------------
# Test: Risk cards include evidence from specific sources
# ---------------------------------------------------------------------------

class TestRiskEvidence:
    def test_risk_with_structured_evidence_passes_validation(self):
        """Risk with structured evidence dicts referencing task/member data."""
        output = validate_agent_output(
            AgentEventType.risk,
            {
                "risks": [
                    {
                        "type": "dependency",
                        "severity": "high",
                        "title": "CI/CD task is blocked",
                        "description": "task-deploy is blocked and overdue.",
                        "evidence": [
                            {"task_id": "task-deploy", "status": "blocked", "due_date": "2026-06-04", "detail": "Task is blocked and past due date"},
                        ],
                        "recommendation": "Resolve the blocker before continuing.",
                        "stage_id": "stage-build",
                        "task_id": "task-deploy",
                    },
                    {
                        "type": "workload",
                        "severity": "medium",
                        "title": "Bob has reduced availability",
                        "description": "Bob's hours dropped to 3h/week during exam week.",
                        "evidence": [
                            {"user_id": "u-bob", "available_hours_per_week": 3, "detail": "Availability dropped due to exam week constraint"},
                        ],
                        "recommendation": "Consider reassigning frontend tasks to another member.",
                    },
                ],
                "requires_confirmation": True,
                "reason": "High severity dependency risk and workload risk.",
            },
            workspace_state=_blocked_availability_drop_state(),
        )
        assert isinstance(output, RiskAnalysisOutput)
        assert len(output.risks) == 2
        # Evidence must be non-empty
        assert len(output.risks[0].evidence) >= 1
        assert len(output.risks[1].evidence) >= 1
        # Evidence contains structured data
        assert "task_id" in output.risks[0].evidence[0]
        assert "user_id" in output.risks[1].evidence[0]


# ---------------------------------------------------------------------------
# Test: Replan proposals include before/after/impact/reason/confirmation
# ---------------------------------------------------------------------------

class TestReplanProposal:
    def test_replan_with_before_after_impact_reason(self):
        """Replan output includes before, after, impact, reason, and
        requires_confirmation is forced True."""
        output = validate_agent_output(
            AgentEventType.replan,
            {
                "before": {"task-deploy": "Due 2026-06-04, blocked", "task-ui": "Unassigned"},
                "after": {"task-deploy": "Due 2026-06-08, unblocked", "task-ui": "Assigned to Bob"},
                "impact": "Delays deploy by 4 days but stays within project deadline.",
                "stage_adjustments": [
                    {
                        "stage_id": "stage-build",
                        "new_end_date": "2026-06-09",
                        "reason": "CI/CD unblock delayed; extend build stage.",
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
                        "type": "risk_action",
                        "title": "Resolve CI/CD blocker",
                        "content": "Bob needs to unblock the deploy task.",
                        "reason": "task-deploy is the critical path blocker.",
                        "goal": "Unblock the CI/CD pipeline",
                        "start_suggestion": "Check deploy.yml for missing config",
                        "completion_standard": "CI pipeline runs green",
                        "user_id": "u-bob",
                        "task_id": "task-deploy",
                        "stage_id": "stage-build",
                    }
                ],
                "requires_confirmation": True,
                "reason": "Replan grounded in blocked task evidence and member availability.",
            },
            workspace_state=_blocked_availability_drop_state(),
        )
        assert isinstance(output, ReplanOutput)
        assert output.before is not None
        assert output.after is not None
        assert output.impact
        assert output.reason
        assert output.requires_confirmation is True
        # Action card in replan has goal/start_suggestion/completion_standard
        assert output.action_cards[0].goal is not None
        assert output.action_cards[0].start_suggestion is not None
        assert output.action_cards[0].completion_standard is not None


# ---------------------------------------------------------------------------
# Test: High-risk suggestions do not modify finalized task ownership
# ---------------------------------------------------------------------------

@pytest.fixture(name="session")
def session_fixture():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


class TestFinalizedAssignmentGuard:
    def test_replan_cannot_change_owner_of_finalized_task(self, session: Session):
        """Replan confirm must reject owner changes for tasks with
        finalized assignments."""
        # Set up project, stage, task, users
        user_alice = User(id="u-alice", display_name="Alice")
        user_bob = User(id="u-bob", display_name="Bob")
        session.add(user_alice)
        session.add(user_bob)
        session.flush()

        # Add workspace membership for the users
        from app.models import WorkspaceMembership
        session.add(WorkspaceMembership(id="wm-guard-1", workspace_id="ws-1", user_id="u-alice", role="owner"))
        session.add(WorkspaceMembership(id="wm-guard-2", workspace_id="ws-1", user_id="u-bob", role="member"))
        session.flush()

        project = Project(
            id="proj-guard",
            workspace_id="ws-1",
            name="Guard Test",
            idea="Test finalized guard",
            deadline="2026-06-14",
            deliverables="Test",
            created_by="u-alice",
        )
        session.add(project)
        session.flush()

        stage = Stage(
            id="stage-guard",
            project_id="proj-guard",
            name="Build",
            goal="Test",
            start_date="2026-05-29",
            end_date="2026-06-07",
            deliverable="Test",
            order_index=0,
        )
        session.add(stage)
        session.flush()

        task = Task(
            id="task-guard",
            project_id="proj-guard",
            stage_id="stage-guard",
            title="Guarded task",
            description="Has finalized assignment",
            priority="P0",
            due_date="2026-06-05",
            estimated_hours=4,
            owner_user_id=None,  # Will be set by finalization
        )
        session.add(task)
        session.flush()

        # Create and finalize an assignment proposal
        proposal = create_assignment_proposal(
            session,
            AssignmentProposalCreate(
                project_id="proj-guard",
                stage_id="stage-guard",
                task_id="task-guard",
                recommended_owner_user_id="u-alice",
                reason="Alice has backend skills.",
                skill_match="backend matches API task",
                availability_match="10h/week available",
                created_by_agent=True,
            ),
        )
        # Simulate owner confirmation and finalization
        proposal.status = AssignmentProposalStatus.owner_confirmed
        session.add(proposal)
        session.flush()
        finalize_assignment_proposal(session, proposal.id)

        # Attempt replan that changes owner — must fail
        with pytest.raises(ValueError, match="finalized assignment"):
            confirm_replan(
                session,
                ReplanConfirmRequest(
                    project_id="proj-guard",
                    before={"task-guard": "Owned by Alice"},
                    after={"task-guard": "Owned by Bob"},
                    impact="Swaps owner.",
                    reason="Try to reassign.",
                    requires_confirmation=True,
                    stage_adjustments=[],
                    task_changes=[
                        ReplanTaskChange(
                            task_id="task-guard",
                            owner_user_id="u-bob",
                            reason="Bob is available.",
                        )
                    ],
                    action_cards=[],
                ),
            )

    def test_replan_can_change_non_ownership_fields_on_finalized_task(self, session: Session):
        """Replan can still change due_date or can_cut on a finalized task,
        just not owner_user_id."""
        user_alice = User(id="u-alice2", display_name="Alice2")
        session.add(user_alice)
        session.flush()

        # Add workspace membership for user
        from app.models import WorkspaceMembership
        session.add(WorkspaceMembership(id="wm-guard2-1", workspace_id="ws-1", user_id="u-alice2", role="owner"))
        session.flush()

        project = Project(
            id="proj-guard2",
            workspace_id="ws-1",
            name="Guard Test 2",
            idea="Test non-owner changes",
            deadline="2026-06-14",
            deliverables="Test",
            created_by="u-alice2",
        )
        session.add(project)
        session.flush()

        stage = Stage(
            id="stage-guard2",
            project_id="proj-guard2",
            name="Build",
            goal="Test",
            start_date="2026-05-29",
            end_date="2026-06-07",
            deliverable="Test",
            order_index=0,
        )
        session.add(stage)
        session.flush()

        task = Task(
            id="task-guard2",
            project_id="proj-guard2",
            stage_id="stage-guard2",
            title="Guarded task 2",
            description="Has finalized assignment",
            priority="P0",
            due_date="2026-06-05",
            estimated_hours=4,
            owner_user_id=None,  # Will be set by finalization
        )
        session.add(task)
        session.flush()

        proposal = create_assignment_proposal(
            session,
            AssignmentProposalCreate(
                project_id="proj-guard2",
                stage_id="stage-guard2",
                task_id="task-guard2",
                recommended_owner_user_id="u-alice2",
                reason="Alice2 has backend skills.",
                created_by_agent=True,
            ),
        )
        proposal.status = AssignmentProposalStatus.owner_confirmed
        session.add(proposal)
        session.flush()
        finalize_assignment_proposal(session, proposal.id)

        # Replan that only changes due_date — should succeed
        result = confirm_replan(
            session,
            ReplanConfirmRequest(
                project_id="proj-guard2",
                before={"task-guard2": "Due 2026-06-05"},
                after={"task-guard2": "Due 2026-06-08"},
                impact="Delays task by 3 days.",
                reason="Need more time.",
                requires_confirmation=True,
                stage_adjustments=[],
                task_changes=[
                    ReplanTaskChange(
                        task_id="task-guard2",
                        due_date="2026-06-08",
                        reason="Extend deadline.",
                    )
                ],
                action_cards=[],
            ),
        )
        assert result.confirmed is True
        # Verify task due_date changed but owner stayed
        updated_task = session.get(Task, "task-guard2")
        assert updated_task.due_date == "2026-06-08"
        assert updated_task.owner_user_id == "u-alice2"


# ---------------------------------------------------------------------------
# Test: Fallback payloads cite real member data
# ---------------------------------------------------------------------------

class TestFallbackCitations:
    def test_assignment_fallback_cites_real_member_data(self):
        """Assignment fallback payload includes skill_match, availability_match,
        preference_match, constraint_respected citing real member data."""
        from app.agent.modules import assignment_recommendation

        state = _blocked_availability_drop_state()
        request = assignment_recommendation.build_request(state)
        fallback = request.fallback_payload

        # Fallback assignments should have citation fields
        assignment = fallback["assignments"][0]
        assert "skill_match" in assignment
        assert assignment["skill_match"] is not None
        assert "availability_match" in assignment
        assert assignment["availability_match"] is not None
        assert "preference_match" in assignment
        assert assignment["preference_match"] is not None
        assert "constraint_respected" in assignment

    def test_push_fallback_includes_goal_and_suggestions(self):
        """Active push fallback payload includes goal, start_suggestion,
        completion_standard."""
        from app.agent.modules import active_push

        state = _blocked_availability_drop_state()
        request = active_push.build_request(state)
        fallback = request.fallback_payload

        card = fallback["action_cards"][0]
        assert "goal" in card
        assert card["goal"] is not None
        assert "start_suggestion" in card
        assert card["start_suggestion"] is not None
        assert "completion_standard" in card
        assert card["completion_standard"] is not None

    def test_all_fallback_payloads_validate_against_schemas(self):
        """All module fallback payloads pass schema validation."""
        from app.agent.modules import (
            active_push,
            assignment_recommendation,
            risk_analysis,
            replanning,
        )

        state = _blocked_availability_drop_state()

        for module, event_type in [
            (assignment_recommendation, AgentEventType.assign),
            (active_push, AgentEventType.push),
            (risk_analysis, AgentEventType.risk),
            (replanning, AgentEventType.replan),
        ]:
            request = module.build_request(state)
            # Must not raise
            validate_agent_output(
                event_type,
                request.fallback_payload,
                workspace_state=state,
            )
