import json
from typing import Any

from sqlmodel import Session, select

from app.models import (
    ActionCard,
    AgentEvent,
    AgentProposal,
    AssignmentNegotiation,
    AssignmentProposal,
    AssignmentResponse,
    CheckInCycle,
    MemberProfile,
    Project,
    ProjectResource,
    Risk,
    Stage,
    Task,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.schemas.action_card import ActionCardRead
from app.schemas.agent_event import AgentEventRead
from app.schemas.agent_proposal import AgentProposalRead
from app.schemas.assignment import (
    AssignmentNegotiationRead,
    AssignmentProposalRead,
    AssignmentResponseRead,
)
from app.schemas.checkin import CheckInCycleRead
from app.schemas.member_profile import MemberProfileRead
from app.schemas.project import ProjectRead
from app.schemas.project_state import ProjectStateRead, ProjectStateRepairRead
from app.schemas.resource import ResourceRead
from app.schemas.risk import RiskRead
from app.schemas.stage import StageRead
from app.schemas.task import TaskRead
from app.schemas.user import UserRead
from app.schemas.workspace import WorkspaceMembershipRead, WorkspaceRead
from app.services.project_service import normalize_direction_card


def _json_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _json_payload(value: Any) -> dict | list:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, (dict, list)) else {}


def _from_attributes(schema, row):
    return schema.model_validate(row, from_attributes=True)


def _project_to_read(project: Project) -> ProjectRead:
    return ProjectRead(
        id=project.id,
        workspace_id=project.workspace_id,
        name=project.name,
        idea=project.idea,
        deadline=project.deadline,
        deliverables=project.deliverables,
        status=project.status,
        current_stage_id=project.current_stage_id,
        direction_card=normalize_direction_card(project.direction_card),
        created_by=project.created_by,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def _profile_to_read(profile: MemberProfile) -> MemberProfileRead:
    return MemberProfileRead(
        id=profile.id,
        user_id=profile.user_id,
        workspace_id=profile.workspace_id,
        skills=_json_list(profile.skills),
        available_hours_per_week=profile.available_hours_per_week,
        role_preference=profile.role_preference,
        interests=profile.interests,
        constraints=profile.constraints,
        collaboration_preference=profile.collaboration_preference,
        created_at=profile.created_at,
        updated_at=profile.updated_at,
    )


def _stage_to_read(stage: Stage) -> StageRead:
    return StageRead(
        id=stage.id,
        project_id=stage.project_id,
        name=stage.name,
        goal=stage.goal,
        start_date=stage.start_date,
        end_date=stage.end_date,
        deliverable=stage.deliverable,
        done_criteria=_json_list(stage.done_criteria),
        status=stage.status,
        order_index=stage.order_index,
    )


def _task_to_read(task: Task) -> TaskRead:
    return TaskRead(
        id=task.id,
        project_id=task.project_id,
        stage_id=task.stage_id,
        title=task.title,
        description=task.description,
        priority=task.priority,
        status=task.status,
        owner_user_id=task.owner_user_id,
        backup_owner_user_id=task.backup_owner_user_id,
        due_date=task.due_date,
        estimated_hours=task.estimated_hours,
        dependency_ids=_json_list(task.dependency_ids),
        acceptance_criteria=_json_list(task.acceptance_criteria),
        can_cut=task.can_cut,
        assignment_reason=task.assignment_reason,
        created_by_agent=task.created_by_agent,
        order_index=task.order_index,
        updated_at=task.updated_at,
    )


def _risk_to_read(risk: Risk) -> RiskRead:
    return RiskRead(
        id=risk.id,
        project_id=risk.project_id,
        stage_id=risk.stage_id,
        task_id=risk.task_id,
        type=risk.type,
        severity=risk.severity,
        title=risk.title,
        description=risk.description,
        evidence=_json_list(risk.evidence),
        recommendation=risk.recommendation,
        status=risk.status,
        created_by_agent=risk.created_by_agent,
        created_at=risk.created_at,
    )


def _agent_proposal_to_read(proposal: AgentProposal) -> AgentProposalRead:
    return AgentProposalRead(
        id=proposal.id,
        project_id=proposal.project_id,
        workspace_id=proposal.workspace_id,
        proposal_type=proposal.proposal_type,
        status=proposal.status,
        agent_event_id=proposal.agent_event_id,
        payload=_json_payload(proposal.payload),
        confirmed_by=proposal.confirmed_by,
        confirmed_at=proposal.confirmed_at,
        rejection_reason=proposal.rejection_reason,
        created_at=proposal.created_at,
    )


def _event_to_read(event: AgentEvent) -> AgentEventRead:
    return AgentEventRead(
        id=event.id,
        project_id=event.project_id,
        workspace_id=event.workspace_id,
        event_type=event.event_type,
        status=event.status,
        input_snapshot=event.get_input_snapshot(),
        output_snapshot=event.get_output_snapshot(),
        reasoning_summary=event.reasoning_summary,
        user_confirmed=event.user_confirmed,
        created_at=event.created_at,
    )


def _build_assignment_responses(session: Session, project_id: str) -> list:
    """Pre-fetch proposal IDs then batch-query responses (avoids SQL subquery issues)."""
    proposal_ids = [
        p.id for p in session.exec(
            select(AssignmentProposal).where(AssignmentProposal.project_id == project_id)
        ).all()
    ]
    if not proposal_ids:
        return []
    return [
        _from_attributes(AssignmentResponseRead, response)
        for response in session.exec(
            select(AssignmentResponse).where(AssignmentResponse.proposal_id.in_(proposal_ids))
        ).all()
    ]


def _repair_stage_progress(session: Session, project_id: str) -> list[str]:
    """Explicitly repair stale stage/project progress after out-of-band changes."""
    from app.services.stage_service import try_advance_stage

    repaired_stage_ids: list[str] = []

    while True:
        repairable_stages = session.exec(
            select(Stage).where(
                Stage.project_id == project_id,
                Stage.status.in_(["active", "at_risk"]),
            )
        ).all()
        if not repairable_stages:
            break

        repairable_stage_ids = [stage.id for stage in repairable_stages]
        all_tasks = session.exec(
            select(Task).where(Task.stage_id.in_(repairable_stage_ids))
        ).all()

        tasks_by_stage: dict[str, list[Task]] = {}
        for task in all_tasks:
            tasks_by_stage.setdefault(task.stage_id, []).append(task)

        repaired_in_this_pass = False
        for stage in repairable_stages:
            stage_tasks = tasks_by_stage.get(stage.id, [])
            done_tasks = [task for task in stage_tasks if task.status == "done"]
            pending_tasks = [task for task in stage_tasks if task.status != "done"]
            if not done_tasks or pending_tasks:
                continue

            try_advance_stage(session, done_tasks[0].id)
            session.flush()
            repaired_stage_ids.append(stage.id)
            repaired_in_this_pass = True
            break

        if not repaired_in_this_pass:
            break

    return repaired_stage_ids


def repair_project_state(session: Session, project_id: str) -> ProjectStateRepairRead | None:
    project = session.get(Project, project_id)
    if project is None:
        return None

    repaired_stage_ids = _repair_stage_progress(session, project_id)
    if repaired_stage_ids:
        session.commit()
        session.refresh(project)

    changed = bool(repaired_stage_ids)
    message = (
        f"已修复 {len(repaired_stage_ids)} 个停滞阶段。"
        if changed
        else "未发现需要修复的停滞阶段或项目进度。"
    )

    return ProjectStateRepairRead(
        project_id=project.id,
        changed=changed,
        repaired_stage_ids=repaired_stage_ids,
        current_stage_id=project.current_stage_id,
        project_status=project.status,
        message=message,
    )


def get_project_state(session: Session, project_id: str) -> ProjectStateRead | None:
    project = session.get(Project, project_id)
    if project is None:
        return None

    workspace = session.get(Workspace, project.workspace_id)
    if workspace is None:
        return None

    memberships = session.exec(
        select(WorkspaceMembership).where(WorkspaceMembership.workspace_id == workspace.id)
    ).all()
    member_ids = [membership.user_id for membership in memberships]
    members = session.exec(select(User).where(User.id.in_(member_ids))).all() if member_ids else []

    return ProjectStateRead(
        workspace=_from_attributes(WorkspaceRead, workspace),
        project=_project_to_read(project),
        resources=[
            _from_attributes(ResourceRead, resource)
            for resource in session.exec(
                select(ProjectResource).where(ProjectResource.project_id == project_id)
            ).all()
        ],
        members=[_from_attributes(UserRead, member) for member in members],
        memberships=[
            _from_attributes(WorkspaceMembershipRead, membership)
            for membership in memberships
        ],
        member_profiles=[
            _profile_to_read(profile)
            for profile in session.exec(
                select(MemberProfile).where(MemberProfile.workspace_id == workspace.id)
            ).all()
        ],
        projects=[
            _project_to_read(item)
            for item in session.exec(
                select(Project).where(Project.workspace_id == workspace.id)
            ).all()
        ],
        stages=[
            _stage_to_read(stage)
            for stage in session.exec(
                select(Stage).where(Stage.project_id == project_id).order_by(Stage.order_index)
            ).all()
        ],
        tasks=[
            _task_to_read(task)
            for task in session.exec(
                select(Task)
                .where(Task.project_id == project_id)
                .order_by(Task.stage_id, Task.order_index, Task.priority, Task.due_date)
            ).all()
        ],
        agent_proposals=[
            _agent_proposal_to_read(proposal)
            for proposal in session.exec(
                select(AgentProposal).where(AgentProposal.project_id == project_id)
            ).all()
        ],
        assignment_proposals=[
            _from_attributes(AssignmentProposalRead, proposal)
            for proposal in session.exec(
                select(AssignmentProposal).where(AssignmentProposal.project_id == project_id)
            ).all()
        ],
        assignment_responses=_build_assignment_responses(session, project_id),
        assignment_negotiations=[
            _from_attributes(AssignmentNegotiationRead, negotiation)
            for negotiation in session.exec(
                select(AssignmentNegotiation).where(AssignmentNegotiation.project_id == project_id)
            ).all()
        ],
        checkins=[
            _from_attributes(CheckInCycleRead, cycle)
            for cycle in session.exec(
                select(CheckInCycle).where(CheckInCycle.project_id == project_id)
            ).all()
        ],
        risks=[
            _risk_to_read(risk)
            for risk in session.exec(select(Risk).where(Risk.project_id == project_id)).all()
        ],
        action_cards=[
            _from_attributes(ActionCardRead, card)
            for card in session.exec(
                select(ActionCard).where(ActionCard.project_id == project_id)
            ).all()
        ],
        timeline=[
            _event_to_read(event)
            for event in session.exec(
                select(AgentEvent)
                .where(AgentEvent.project_id == project_id)
                .order_by(AgentEvent.created_at.desc())
            ).all()
        ],
    )
