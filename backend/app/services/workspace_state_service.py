import json

from sqlmodel import Session, select

from app.models import (
    Workspace,
    WorkspaceMembership,
    MemberProfile,
    User,
    Project,
    Stage,
    Task,
)
from app.models.checkin import CheckInCycle, CheckInResponse
from app.schemas.workspace_state import (
    MemberState,
    StageState,
    TaskState,
    CheckInCycleState,
    CheckInResponseState,
    ProjectState,
    WorkspaceStateResponse,
)


def _json_list(value: str | None) -> list:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def _json_object(value: str | None) -> dict | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def get_workspace_state(session: Session, workspace_id: str) -> WorkspaceStateResponse | None:
    workspace = session.get(Workspace, workspace_id)
    if not workspace:
        return None

    # Members with profiles
    membership_rows = session.exec(
        select(WorkspaceMembership).where(WorkspaceMembership.workspace_id == workspace_id)
    ).all()
    members: list[MemberState] = []
    for mem in membership_rows:
        user = session.get(User, mem.user_id)
        if not user:
            continue
        profile = session.exec(
            select(MemberProfile).where(
                MemberProfile.user_id == mem.user_id,
                MemberProfile.workspace_id == workspace_id,
            )
        ).first()
        members.append(MemberState(
            user_id=user.id,
            display_name=user.display_name,
            skills=json.loads(profile.skills) if profile and profile.skills else [],
            available_hours_per_week=profile.available_hours_per_week if profile else 0.0,
            role_preference=profile.role_preference if profile else "",
            interests=profile.interests if profile else "",
            constraints=profile.constraints if profile else "",
        ))

    # Active project (first active or draft project in workspace)
    project_row = session.exec(
        select(Project)
        .where(Project.workspace_id == workspace_id)
        .order_by(Project.created_at.desc())
    ).first()

    project_state: ProjectState | None = None
    if project_row:
        stage_rows = session.exec(
            select(Stage).where(Stage.project_id == project_row.id).order_by(Stage.order_index)
        ).all()
        stages = [StageState(
            id=s.id,
            name=s.name,
            goal=s.goal,
            start_date=s.start_date,
            end_date=s.end_date,
            deliverable=s.deliverable,
            done_criteria=_json_list(s.done_criteria),
            status=s.status if isinstance(s.status, str) else s.status.value,
            order_index=s.order_index,
        ) for s in stage_rows]

        task_rows = session.exec(
            select(Task).where(Task.project_id == project_row.id)
        ).all()
        tasks = [TaskState(
            id=t.id,
            stage_id=t.stage_id,
            title=t.title,
            description=t.description,
            status=t.status if isinstance(t.status, str) else t.status.value,
            priority=t.priority if isinstance(t.priority, str) else t.priority.value,
            owner_user_id=t.owner_user_id,
            backup_owner_user_id=t.backup_owner_user_id,
            due_date=t.due_date or None,
            estimated_hours=t.estimated_hours,
            dependency_ids=_json_list(t.dependency_ids),
            acceptance_criteria=_json_list(t.acceptance_criteria),
            can_cut=t.can_cut,
            assignment_reason=t.assignment_reason,
        ) for t in task_rows]

        # Check-in data
        checkin_cycle_rows = session.exec(
            select(CheckInCycle).where(CheckInCycle.project_id == project_row.id)
        ).all()
        checkin_cycles = [CheckInCycleState(
            id=c.id,
            stage_id=c.stage_id,
            cadence_days=c.cadence_days,
            next_due_date=c.next_due_date,
            status=c.status,
        ) for c in checkin_cycle_rows]

        checkin_response_rows = session.exec(
            select(CheckInResponse).where(CheckInResponse.project_id == project_row.id)
        ).all()
        checkin_responses = [CheckInResponseState(
            id=r.id,
            cycle_id=r.cycle_id,
            user_id=r.user_id,
            task_id=r.task_id,
            what_done=r.what_done,
            blocker=r.blocker,
            available_hours_next_cycle=r.available_hours_next_cycle,
            mood_or_confidence=r.mood_or_confidence,
        ) for r in checkin_response_rows]

        project_state = ProjectState(
            id=project_row.id, name=project_row.name, idea=project_row.idea,
            deadline=project_row.deadline,
            deliverables=project_row.deliverables,
            direction_card=_json_object(project_row.direction_card),
            status=project_row.status if isinstance(project_row.status, str) else project_row.status.value,
            current_stage_id=project_row.current_stage_id,
            stages=stages, tasks=tasks,
            checkin_cycles=checkin_cycles,
            checkin_responses=checkin_responses,
        )

    return WorkspaceStateResponse(
        workspace_id=workspace.id,
        workspace_name=workspace.name,
        members=members,
        project=project_state,
    )
