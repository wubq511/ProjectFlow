import json
from datetime import datetime
from enum import Enum

from sqlmodel import Session, select

from app.models import (
    Workspace,
    WorkspaceMembership,
    MemberProfile,
    User,
    Project,
    Stage,
    Task,
    AssignmentProposal,
    AssignmentResponse,
    AssignmentNegotiation,
    ProjectResource,
)
from app.models.checkin import CheckInCycle, CheckInResponse
from app.schemas.workspace_state import (
    MemberState,
    StageState,
    TaskState,
    CheckInCycleState,
    CheckInResponseState,
    AssignmentProposalState,
    AssignmentResponseState,
    AssignmentNegotiationState,
    ResourceState,
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


def get_workspace_state(
    session: Session,
    workspace_id: str,
    *,
    project_id: str | None = None,
) -> WorkspaceStateResponse | None:
    workspace = session.get(Workspace, workspace_id)
    if not workspace:
        return None

    # Members with profiles
    membership_rows = session.exec(
        select(WorkspaceMembership).where(WorkspaceMembership.workspace_id == workspace_id)
    ).all()
    member_ids = [mem.user_id for mem in membership_rows]
    users_by_id = {
        user.id: user
        for user in session.exec(select(User).where(User.id.in_(member_ids))).all()
    } if member_ids else {}
    profiles_by_user_id = {
        profile.user_id: profile
        for profile in session.exec(
            select(MemberProfile).where(
                MemberProfile.workspace_id == workspace_id,
                MemberProfile.user_id.in_(member_ids),
            )
        ).all()
    } if member_ids else {}

    members: list[MemberState] = []
    for mem in membership_rows:
        user = users_by_id.get(mem.user_id)
        if not user:
            continue
        profile = profiles_by_user_id.get(mem.user_id)
        members.append(MemberState(
            user_id=user.id,
            display_name=user.display_name,
            skills=json.loads(profile.skills) if profile and profile.skills else [],
            available_hours_per_week=profile.available_hours_per_week if profile else 0.0,
            role_preference=profile.role_preference if profile else "",
            interests=profile.interests if profile else "",
            constraints=profile.constraints if profile else "",
        ))

    # Active project — use explicit project_id when provided, otherwise pick
    # the most-recently-created project in the workspace.
    if project_id:
        project_row = session.get(Project, project_id)
        if project_row is not None and project_row.workspace_id != workspace_id:
            project_row = None  # project does not belong to this workspace
    else:
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
            status=c.status.value if isinstance(c.status, Enum) else c.status,
            name=f"签到周期（{c.start_date}，每{c.cadence_days}天）",
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

        # Assignment data
        assignment_proposal_rows = session.exec(
            select(AssignmentProposal).where(AssignmentProposal.project_id == project_row.id)
        ).all()
        proposal_ids = [p.id for p in assignment_proposal_rows]
        assignment_response_rows = session.exec(
            select(AssignmentResponse).where(AssignmentResponse.proposal_id.in_(proposal_ids))
        ).all() if proposal_ids else []
        assignment_negotiation_rows = session.exec(
            select(AssignmentNegotiation).where(AssignmentNegotiation.project_id == project_row.id)
        ).all()
        assignment_proposals = [AssignmentProposalState(
            id=p.id,
            stage_id=p.stage_id,
            task_id=p.task_id,
            recommended_owner_user_id=p.recommended_owner_user_id,
            backup_owner_user_id=p.backup_owner_user_id,
            status=p.status.value if isinstance(p.status, Enum) else p.status,
        ) for p in assignment_proposal_rows]
        assignment_responses = [AssignmentResponseState(
            id=r.id,
            proposal_id=r.proposal_id,
            user_id=r.user_id,
            response=r.response.value if isinstance(r.response, Enum) else r.response,
            preferred_task_id=r.preferred_task_id,
            reason=r.reason,
        ) for r in assignment_response_rows]
        assignment_negotiations = [AssignmentNegotiationState(
            id=n.id,
            stage_id=n.stage_id,
            from_user_id=n.from_user_id,
            desired_task_id=n.desired_task_id,
            current_owner_user_id=n.current_owner_user_id,
            status=n.status.value if isinstance(n.status, Enum) else n.status,
        ) for n in assignment_negotiation_rows]

        # Resources
        resource_rows = session.exec(
            select(ProjectResource).where(ProjectResource.project_id == project_row.id)
        ).all()
        resources = [ResourceState(
            id=r.id,
            type=r.type,
            title=r.title,
            content_text=r.content_text[:200] if r.content_text else None,
            file_name=r.file_name,
            url=r.url,
            created_at=r.created_at.isoformat(),
        ) for r in resource_rows]

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
            assignment_proposals=assignment_proposals,
            assignment_responses=assignment_responses,
            assignment_negotiations=assignment_negotiations,
            resources=resources,
        )

    # Determine current date/time with timezone awareness
    # The project operates in Asia/Shanghai timezone for display consistency
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("Asia/Shanghai")
        timezone_name = "Asia/Shanghai"
    except (ImportError, KeyError, ModuleNotFoundError):
        from datetime import timedelta, timezone as dt_tz
        tz = dt_tz(timedelta(hours=8))
        timezone_name = "UTC+8"
    now_local = datetime.now(tz)

    return WorkspaceStateResponse(
        workspace_id=workspace.id,
        workspace_name=workspace.name,
        members=members,
        project=project_state,
        current_date=now_local.strftime("%Y-%m-%d"),
        current_datetime=now_local.isoformat(),
        timezone=timezone_name,
    )
