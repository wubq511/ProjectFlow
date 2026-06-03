"""Smoke tests: verify all domain model tables can be created, inserted, and read."""
import json
import uuid
from datetime import date

import pytest
from sqlmodel import SQLModel, Session, create_engine

# Import all models so they register with SQLModel metadata
import app.models  # noqa: F401
from app.models import (
    User,
    Workspace,
    WorkspaceMembership,
    Invitation,
    MemberProfile,
    Project,
    ProjectResource,
    Stage,
    Task,
    TaskStatusUpdate,
    AssignmentProposal,
    AssignmentResponse,
    AssignmentNegotiation,
    CheckInCycle,
    CheckInResponse,
    Risk,
    ActionCard,
    AgentEvent,
)
from app.models.enums import (
    WorkspaceRole,
    InvitationStatus,
    ProjectStatus,
    ResourceType,
    StageStatus,
    TaskPriority,
    TaskStatus,
    AssignmentProposalStatus,
    AssignmentResponseType,
    NegotiationStatus,
    CheckInCycleStatus,
    MoodOrConfidence,
    RiskType,
    RiskSeverity,
    RiskStatus,
    ActionCardType,
    ActionCardStatus,
    AgentEventType,
)


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


def _uuid() -> str:
    return str(uuid.uuid4())


def test_user_crud(session: Session):
    user = User(display_name="TestUser", email="test@example.com")
    session.add(user)
    session.commit()
    session.refresh(user)
    assert user.id
    assert user.display_name == "TestUser"
    assert user.email == "test@example.com"


def test_workspace_and_membership(session: Session):
    user = User(display_name="Owner")
    session.add(user)
    session.commit()

    ws = Workspace(name="Team", owner_user_id=user.id)
    session.add(ws)
    session.commit()

    membership = WorkspaceMembership(workspace_id=ws.id, user_id=user.id, role=WorkspaceRole.owner)
    session.add(membership)
    session.commit()
    session.refresh(membership)
    assert membership.role == WorkspaceRole.owner


def test_invitation(session: Session):
    user = User(display_name="Owner")
    ws = Workspace(name="WS", owner_user_id=user.id)
    session.add_all([user, ws])
    session.commit()

    inv = Invitation(workspace_id=ws.id, invited_name="NewMember")
    session.add(inv)
    session.commit()
    session.refresh(inv)
    assert inv.status == InvitationStatus.pending
    assert inv.token


def test_member_profile(session: Session):
    user = User(display_name="Member")
    ws = Workspace(name="WS", owner_user_id=user.id)
    session.add_all([user, ws])
    session.commit()

    profile = MemberProfile(
        user_id=user.id,
        workspace_id=ws.id,
        skills='[{"name": "frontend", "level": 3}]',
        available_hours_per_week=8,
        role_preference="UI",
        interests="design",
        constraints="none",
    )
    session.add(profile)
    session.commit()
    session.refresh(profile)
    assert profile.skills == '[{"name": "frontend", "level": 3}]'


def test_project_and_resource(session: Session):
    user = User(display_name="Owner")
    ws = Workspace(name="WS", owner_user_id=user.id)
    session.add_all([user, ws])
    session.commit()

    project = Project(
        workspace_id=ws.id,
        name="ProjectFlow",
        idea="AI agent for teams",
        deadline=date(2026, 6, 9),
        deliverables="MVP demo",
        created_by=user.id,
    )
    session.add(project)
    session.commit()

    resource = ProjectResource(
        project_id=project.id,
        type=ResourceType.text_note,
        title="Background",
        content_text="Some notes",
    )
    session.add(resource)
    session.commit()
    session.refresh(project)
    assert project.status == ProjectStatus.draft
    session.refresh(resource)
    assert resource.type == ResourceType.text_note


def test_stage(session: Session):
    user = User(display_name="Owner")
    ws = Workspace(name="WS", owner_user_id=user.id)
    project = Project(
        workspace_id=ws.id,
        name="P",
        idea="idea",
        deadline=date(2026, 6, 9),
        deliverables="demo",
        created_by=user.id,
    )
    session.add_all([user, ws, project])
    session.commit()

    stage = Stage(
        project_id=project.id,
        name="Phase 1",
        goal="Build core",
        start_date=date(2026, 5, 28),
        end_date=date(2026, 6, 1),
        deliverable="Core module",
        done_criteria='["All P0 tasks done"]',
        order_index=0,
    )
    session.add(stage)
    session.commit()
    session.refresh(stage)
    assert stage.status == StageStatus.pending


def test_task_and_status_update(session: Session):
    user = User(display_name="Owner")
    ws = Workspace(name="WS", owner_user_id=user.id)
    project = Project(
        workspace_id=ws.id, name="P", idea="i", deadline=date(2026, 6, 9),
        deliverables="d", created_by=user.id,
    )
    session.add_all([user, ws, project])
    session.commit()

    stage = Stage(
        project_id=project.id, name="S1", goal="g",
        start_date=date(2026, 5, 28), end_date=date(2026, 6, 1),
        deliverable="d",
    )
    session.add(stage)
    session.commit()

    task = Task(
        project_id=project.id,
        stage_id=stage.id,
        title="Implement models",
        description="Write all domain models",
        priority=TaskPriority.P0,
        due_date=date(2026, 5, 29),
        estimated_hours=10,
        can_cut=False,
    )
    session.add(task)
    session.commit()

    update = TaskStatusUpdate(
        task_id=task.id,
        user_id=user.id,
        status=TaskStatus.in_progress,
        progress_note="Started",
    )
    session.add(update)
    session.commit()
    session.refresh(task)
    assert task.priority == TaskPriority.P0
    session.refresh(update)
    assert update.status == TaskStatus.in_progress


def test_assignment_flow(session: Session):
    user = User(display_name="Owner")
    member = User(display_name="Member")
    ws = Workspace(name="WS", owner_user_id=user.id)
    project = Project(
        workspace_id=ws.id, name="P", idea="i", deadline=date(2026, 6, 9),
        deliverables="d", created_by=user.id,
    )
    session.add_all([user, member, ws, project])
    session.commit()

    stage = Stage(
        project_id=project.id, name="S1", goal="g",
        start_date=date(2026, 5, 28), end_date=date(2026, 6, 1),
        deliverable="d",
    )
    session.add(stage)
    session.commit()

    task = Task(
        project_id=project.id, stage_id=stage.id, title="T1",
        description="desc", due_date=date(2026, 5, 29),
    )
    session.add(task)
    session.commit()

    proposal = AssignmentProposal(
        project_id=project.id,
        stage_id=stage.id,
        task_id=task.id,
        recommended_owner_user_id=member.id,
        reason="Best fit for frontend",
        created_by_agent=True,
    )
    session.add(proposal)
    session.commit()

    response = AssignmentResponse(
        proposal_id=proposal.id,
        user_id=member.id,
        response=AssignmentResponseType.accept,
    )
    session.add(response)
    session.commit()

    negotiation = AssignmentNegotiation(
        project_id=project.id,
        stage_id=stage.id,
        from_user_id=member.id,
        desired_task_id=task.id,
        agent_message="Member prefers this task",
    )
    session.add(negotiation)
    session.commit()

    session.refresh(proposal)
    assert proposal.status == AssignmentProposalStatus.proposed
    session.refresh(response)
    assert response.response == AssignmentResponseType.accept
    session.refresh(negotiation)
    assert negotiation.status == NegotiationStatus.pending


def test_checkin(session: Session):
    user = User(display_name="Owner")
    ws = Workspace(name="WS", owner_user_id=user.id)
    project = Project(
        workspace_id=ws.id, name="P", idea="i", deadline=date(2026, 6, 9),
        deliverables="d", created_by=user.id,
    )
    session.add_all([user, ws, project])
    session.commit()

    stage = Stage(
        project_id=project.id, name="S1", goal="g",
        start_date=date(2026, 5, 28), end_date=date(2026, 6, 1),
        deliverable="d",
    )
    session.add(stage)
    session.commit()

    cycle = CheckInCycle(
        project_id=project.id,
        stage_id=stage.id,
        cadence_days=2,
        start_date=date(2026, 5, 29),
        next_due_date=date(2026, 5, 31),
        created_by_user_id=user.id,
    )
    session.add(cycle)
    session.commit()

    resp = CheckInResponse(
        cycle_id=cycle.id,
        project_id=project.id,
        stage_id=stage.id,
        user_id=user.id,
        what_done="Finished model tests",
        blocker=None,
        mood_or_confidence=MoodOrConfidence.high,
    )
    session.add(resp)
    session.commit()
    session.refresh(cycle)
    assert cycle.status == CheckInCycleStatus.active
    session.refresh(resp)
    assert resp.mood_or_confidence == MoodOrConfidence.high


def test_risk(session: Session):
    user = User(display_name="Owner")
    ws = Workspace(name="WS", owner_user_id=user.id)
    project = Project(
        workspace_id=ws.id, name="P", idea="i", deadline=date(2026, 6, 9),
        deliverables="d", created_by=user.id,
    )
    session.add_all([user, ws, project])
    session.commit()

    risk = Risk(
        project_id=project.id,
        type=RiskType.deadline,
        severity=RiskSeverity.high,
        title="Deadline risk",
        description="May miss deadline",
        evidence='["P0 task blocked"]',
        recommendation="Reassign or cut scope",
        created_by_agent=True,
    )
    session.add(risk)
    session.commit()
    session.refresh(risk)
    assert risk.status == RiskStatus.open
    assert risk.evidence == '["P0 task blocked"]'


def test_action_card(session: Session):
    user = User(display_name="Owner")
    ws = Workspace(name="WS", owner_user_id=user.id)
    project = Project(
        workspace_id=ws.id, name="P", idea="i", deadline=date(2026, 6, 9),
        deliverables="d", created_by=user.id,
    )
    session.add_all([user, ws, project])
    session.commit()

    card = ActionCard(
        project_id=project.id,
        user_id=user.id,
        type=ActionCardType.personal_task,
        title="Start coding",
        content="Begin with domain models",
        reason="P0 task, no blockers",
        due_date=date(2026, 5, 30),
        created_by_agent=True,
    )
    session.add(card)
    session.commit()
    session.refresh(card)
    assert card.status == ActionCardStatus.active


def test_agent_event(session: Session):
    user = User(display_name="Owner")
    ws = Workspace(name="WS", owner_user_id=user.id)
    project = Project(
        workspace_id=ws.id, name="P", idea="i", deadline=date(2026, 6, 9),
        deliverables="d", created_by=user.id,
    )
    session.add_all([user, ws, project])
    session.commit()

    event = AgentEvent(
        project_id=project.id,
        workspace_id=ws.id,
        event_type=AgentEventType.clarify,
        input_snapshot='{"idea": "AI agent"}',
        output_snapshot='{"questions": []}',
        reasoning_summary="Generated clarification questions",
    )
    session.add(event)
    session.commit()
    session.refresh(event)
    assert event.event_type == AgentEventType.clarify
    assert not event.user_confirmed
