from datetime import date

from sqlalchemy import delete
from sqlmodel import Session

from app.models import (
    ActionCard,
    AgentEvent,
    AssignmentNegotiation,
    AssignmentProposal,
    AssignmentResponse,
    CheckInCycle,
    CheckInResponse,
    Invitation,
    MemberProfile,
    Project,
    ProjectResource,
    Risk,
    Stage,
    Task,
    TaskStatusUpdate,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.models.enums import (
    ActionCardType,
    AgentEventStatus,
    AgentEventType,
    AssignmentProposalStatus,
    CheckInCycleStatus,
    ProjectStatus,
    ResourceType,
    RiskSeverity,
    RiskType,
    StageStatus,
    TaskPriority,
    TaskStatus,
    WorkspaceRole,
)
from app.schemas.demo import DemoResetRead


def reset_demo_data(session: Session) -> DemoResetRead:
    _clear_existing_data(session)

    users = [
        User(display_name="Lin", email="lin@example.test"),
        User(display_name="Mia", email="mia@example.test"),
        User(display_name="Chen", email="chen@example.test"),
        User(display_name="Noor", email="noor@example.test"),
        User(display_name="Jay", email="jay@example.test"),
    ]
    session.add_all(users)
    session.commit()
    for user in users:
        session.refresh(user)

    workspace = Workspace(
        name="ProjectFlow Demo Team",
        owner_user_id=users[0].id,
        description="A student team preparing a project demo.",
        project_template="coursework",
    )
    session.add(workspace)
    session.commit()
    session.refresh(workspace)

    session.add_all(
        [
            WorkspaceMembership(
                workspace_id=workspace.id,
                user_id=user.id,
                role=WorkspaceRole.owner if user.id == users[0].id else WorkspaceRole.member,
            )
            for user in users
        ]
    )
    profiles = [
        MemberProfile(
            user_id=users[0].id,
            workspace_id=workspace.id,
            skills=[{"name": "product", "level": 4}, {"name": "backend", "level": 3}],
            available_hours_per_week=12,
            role_preference="project lead",
            interests="agent workflow and demo story",
            constraints="needs concise review material",
        ),
        MemberProfile(
            user_id=users[1].id,
            workspace_id=workspace.id,
            skills=[{"name": "frontend", "level": 4}, {"name": "interaction", "level": 3}],
            available_hours_per_week=8,
            role_preference="frontend",
            interests="dashboard and animations",
            constraints="limited time before Friday",
        ),
        MemberProfile(
            user_id=users[2].id,
            workspace_id=workspace.id,
            skills=[{"name": "backend", "level": 4}, {"name": "testing", "level": 3}],
            available_hours_per_week=10,
            role_preference="backend",
            interests="API reliability",
            constraints="needs clear schemas",
        ),
        MemberProfile(
            user_id=users[3].id,
            workspace_id=workspace.id,
            skills=[{"name": "research", "level": 4}, {"name": "writing", "level": 3}],
            available_hours_per_week=6,
            role_preference="research",
            interests="user scenario and evidence",
            constraints="cannot attend weekend work session",
        ),
        MemberProfile(
            user_id=users[4].id,
            workspace_id=workspace.id,
            skills=[{"name": "presentation", "level": 4}, {"name": "qa", "level": 3}],
            available_hours_per_week=7,
            role_preference="demo owner",
            interests="final presentation",
            constraints="depends on stable export output",
        ),
    ]
    session.add_all(profiles)

    project = Project(
        workspace_id=workspace.id,
        name="AI Study Planner",
        idea="Help student project teams turn messy status into the next concrete action.",
        deadline=date(2026, 6, 7),
        deliverables="Clickable MVP demo, review summary, and 5-minute presentation path",
        project_template="coursework",
        status=ProjectStatus.active,
        direction_card={
            "problem": "Student teams lose time deciding what to do next.",
            "users": "College course project teams",
            "value": "Convert current project state into explainable next actions.",
            "deliverables": ["Working demo", "Review summary", "Presentation path"],
            "boundaries": ["Local-first", "Mock LLM fallback", "One-week demo window", "No production auth", "No multi-agent runtime"],
            "risks": ["Deadline pressure", "Scope drift"],
            "suggested_questions": ["Which review path proves the active-push loop fastest?"],
        },
        created_by=users[0].id,
    )
    session.add(project)
    session.commit()
    session.refresh(project)

    stages = [
        Stage(
            project_id=project.id,
            name="Prototype Loop",
            goal="Run planning, assignments, active push, check-in, risk, and replan in one dashboard.",
            start_date=date(2026, 5, 29),
            end_date=date(2026, 6, 2),
            deliverable="Clickable active-push dashboard",
            done_criteria=["Assignments confirmed", "Risk/replan visible", "Export works"],
            status=StageStatus.active,
            order_index=0,
        ),
        Stage(
            project_id=project.id,
            name="Review Prep",
            goal="Prepare the final demo story and review material.",
            start_date=date(2026, 6, 3),
            end_date=date(2026, 6, 7),
            deliverable="Review-ready presentation",
            done_criteria=["Demo script rehearsed", "Summary exported"],
            status=StageStatus.pending,
            order_index=1,
        ),
    ]
    session.add_all(stages)
    session.commit()
    for stage in stages:
        session.refresh(stage)
    project.current_stage_id = stages[0].id

    resources = [
        ProjectResource(
            project_id=project.id,
            type=ResourceType.text_note,
            title="Course review target",
            content_text="Show that the agent actively moves the project forward.",
        ),
        ProjectResource(
            project_id=project.id,
            type=ResourceType.link,
            title="Demo repository",
            url="https://github.com/wubq511/ProjectFlow",
        ),
    ]
    session.add_all(resources)

    tasks = [
        Task(
            project_id=project.id,
            stage_id=stages[0].id,
            title="Finalize dashboard flow",
            description="Ensure the dashboard shows next action, assignments, check-ins, risks, and export.",
            priority=TaskPriority.P0,
            status=TaskStatus.in_progress,
            owner_user_id=users[1].id,
            backup_owner_user_id=users[2].id,
            due_date=date(2026, 6, 1),
            estimated_hours=6,
            acceptance_criteria=["Agent buttons work", "Execution tabs show real data"],
            assignment_reason="Mia has the strongest frontend fit; Chen can cover API wiring.",
            created_by_agent=True,
        ),
        Task(
            project_id=project.id,
            stage_id=stages[0].id,
            title="Stabilize API loop",
            description="Keep assignment, active push, check-in, risk, and replan endpoints reliable.",
            priority=TaskPriority.P0,
            status=TaskStatus.in_progress,
            owner_user_id=users[2].id,
            backup_owner_user_id=users[0].id,
            due_date=date(2026, 6, 1),
            estimated_hours=5,
            acceptance_criteria=["Backend tests pass", "No fabricated entity references"],
            assignment_reason="Chen has backend/testing strength.",
            created_by_agent=True,
        ),
        Task(
            project_id=project.id,
            stage_id=stages[0].id,
            title="Collect review evidence",
            description="Write concise evidence for risks and decisions.",
            priority=TaskPriority.P1,
            status=TaskStatus.not_started,
            owner_user_id=users[3].id,
            backup_owner_user_id=users[4].id,
            due_date=date(2026, 6, 2),
            estimated_hours=3,
            can_cut=True,
            assignment_reason="Noor is strongest at research evidence.",
            created_by_agent=True,
        ),
        Task(
            project_id=project.id,
            stage_id=stages[1].id,
            title="Rehearse demo script",
            description="Run the 5-minute demo and note failure points.",
            priority=TaskPriority.P1,
            status=TaskStatus.not_started,
            owner_user_id=users[4].id,
            backup_owner_user_id=users[0].id,
            due_date=date(2026, 6, 5),
            estimated_hours=3,
            created_by_agent=True,
        ),
        Task(
            project_id=project.id,
            stage_id=stages[1].id,
            title="Prepare fallback screenshots",
            description="Capture fallback material in case live demo network or machine state fails.",
            priority=TaskPriority.P2,
            status=TaskStatus.not_started,
            owner_user_id=users[4].id,
            due_date=date(2026, 6, 6),
            estimated_hours=2,
            can_cut=True,
            created_by_agent=True,
        ),
    ]
    session.add_all(tasks)
    session.commit()
    for task in tasks:
        session.refresh(task)

    proposals = [
        AssignmentProposal(
            project_id=project.id,
            stage_id=task.stage_id,
            task_id=task.id,
            recommended_owner_user_id=task.owner_user_id or users[0].id,
            backup_owner_user_id=task.backup_owner_user_id,
            reason=task.assignment_reason or "Recommended from skill fit and availability.",
            status=AssignmentProposalStatus.finalized,
            created_by_agent=True,
        )
        for task in tasks[:3]
    ]
    session.add_all(proposals)

    cycle = CheckInCycle(
        project_id=project.id,
        stage_id=stages[0].id,
        cadence_days=2,
        start_date=date(2026, 5, 29),
        next_due_date=date(2026, 5, 31),
        status=CheckInCycleStatus.active,
        created_by_user_id=users[0].id,
    )
    session.add(cycle)
    session.commit()
    session.refresh(cycle)

    session.add(
        CheckInResponse(
            cycle_id=cycle.id,
            project_id=project.id,
            stage_id=stages[0].id,
            user_id=users[1].id,
            task_id=tasks[0].id,
            what_done="Finished the dashboard tabs and found the export endpoint gap.",
            blocker="Export route must be implemented before final rehearsal.",
            available_hours_next_cycle=4,
        )
    )
    session.add(
        TaskStatusUpdate(
            task_id=tasks[0].id,
            user_id=users[1].id,
            status=TaskStatus.blocked,
            progress_note="UI is ready but export backend was missing.",
            blocker="Need review summary endpoint.",
            available_hours_change=-2,
        )
    )
    session.add(
        Risk(
            project_id=project.id,
            stage_id=stages[0].id,
            task_id=tasks[0].id,
            type=RiskType.deadline,
            severity=RiskSeverity.high,
            title="Export gap threatens demo closeout",
            description="The dashboard export button needs a real backend endpoint for the review path.",
            evidence=["frontend export button exists", "backend route was missing"],
            recommendation="Finish export endpoint and rerun the demo path.",
            created_by_agent=True,
        )
    )
    session.add_all(
        [
            ActionCard(
                project_id=project.id,
                stage_id=stages[0].id,
                user_id=users[0].id,
                task_id=tasks[0].id,
                type=ActionCardType.team_next_step,
                title="Confirm the live demo path",
                content="Walk from dashboard actions through risk and export after verification passes.",
                reason="The final review depends on a stable full-loop story.",
                goal="Prove the dashboard can drive a full demo loop.",
                start_suggestion="Open the project dashboard and run through action cards, risk, and export.",
                completion_standard="The review summary exports with current state, risks, and next actions.",
                due_date=date(2026, 5, 31),
                created_by_agent=True,
            ),
            ActionCard(
                project_id=project.id,
                stage_id=stages[0].id,
                user_id=users[1].id,
                task_id=tasks[0].id,
                type=ActionCardType.personal_task,
                title="Retest export panel",
                content="Generate and copy the review summary from the timeline tab.",
                reason="This proves the final handoff surface works.",
                goal="Confirm the export panel works from the UI.",
                start_suggestion="Open the timeline/export tab and generate a review summary.",
                completion_standard="Markdown is generated and includes active push and risk context.",
                due_date=date(2026, 5, 31),
                created_by_agent=True,
            ),
        ]
    )
    session.add(
        AgentEvent(
            project_id=project.id,
            workspace_id=workspace.id,
            event_type=AgentEventType.push,
            status=AgentEventStatus.fallback,
            input_snapshot={"seed": "demo-reset"},
            output_snapshot={"action_cards": 2},
            reasoning_summary="Seeded active push cards for deterministic demo validation.",
        )
    )
    session.add(project)
    session.commit()

    return DemoResetRead(
        workspace_id=workspace.id,
        project_id=project.id,
        user_ids=[user.id for user in users],
        stage_ids=[stage.id for stage in stages],
        task_ids=[task.id for task in tasks],
    )


def _clear_existing_data(session: Session) -> None:
    for model in [
        AgentEvent,
        ActionCard,
        Risk,
        CheckInResponse,
        CheckInCycle,
        AssignmentNegotiation,
        AssignmentResponse,
        AssignmentProposal,
        TaskStatusUpdate,
        Task,
        Stage,
        ProjectResource,
        Project,
        MemberProfile,
        Invitation,
        WorkspaceMembership,
        Workspace,
        User,
    ]:
        session.exec(delete(model))
    session.commit()
