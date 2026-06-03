from datetime import UTC, datetime

from sqlmodel import Session, select

from app.core.db_utils import require_row
from app.models import (
    AssignmentNegotiation,
    AssignmentProposal,
    AssignmentResponse,
    Project,
    Stage,
    Task,
    User,
    WorkspaceMembership,
)
from app.models.enums import (
    AssignmentProposalStatus,
    AssignmentResponseType,
)
from app.schemas.assignment import (
    AssignmentNegotiationCreate,
    AssignmentNegotiationFromProposalCreate,
    AssignmentProposalCreate,
    AssignmentResponseCreate,
)


def _validate_proposal_relationships(session: Session, data: AssignmentProposalCreate) -> None:
    """Verify all entity relationships and state constraints for a new proposal."""
    project = require_row(session, Project, data.project_id, "Project")
    stage = require_row(session, Stage, data.stage_id, "Stage")
    task = require_row(session, Task, data.task_id, "Task")

    # Stage belongs to same project
    if stage.project_id != data.project_id:
        raise ValueError("Stage does not belong to the specified project")

    # Task belongs to same project
    if task.project_id != data.project_id:
        raise ValueError("Task does not belong to the specified project")

    # Task belongs to the specified stage
    if task.stage_id != data.stage_id:
        raise ValueError("Task does not belong to the specified stage")

    # Recommended and backup owners must be workspace members
    member_user_ids = {
        row.user_id
        for row in session.exec(
            select(WorkspaceMembership).where(WorkspaceMembership.workspace_id == project.workspace_id)
        ).all()
    }
    if data.recommended_owner_user_id not in member_user_ids:
        raise ValueError("Recommended owner is not a workspace member")
    if data.backup_owner_user_id and data.backup_owner_user_id not in member_user_ids:
        raise ValueError("Backup owner is not a workspace member")

    # Backup must differ from recommended
    if data.backup_owner_user_id and data.backup_owner_user_id == data.recommended_owner_user_id:
        raise ValueError("Backup owner must differ from recommended owner")

    # Task must not already have an owner
    if task.owner_user_id is not None:
        raise ValueError(f"Task already has owner {task.owner_user_id}")

    # Task must not already have a proposal in an active state
    existing_proposal = session.exec(
        select(AssignmentProposal).where(
            AssignmentProposal.task_id == data.task_id,
            AssignmentProposal.project_id == data.project_id,
            AssignmentProposal.status.in_([
                AssignmentProposalStatus.proposed,
                AssignmentProposalStatus.owner_confirmed,
                AssignmentProposalStatus.negotiating,
                AssignmentProposalStatus.finalized,
            ]),
        )
    ).first()
    if existing_proposal:
        raise ValueError(
            f"Task already has a proposal in status {existing_proposal.status}"
        )

    # Check for rejected (task_id, owner_id) pair
    existing_rejected = session.exec(
        select(AssignmentProposal).where(
            AssignmentProposal.task_id == data.task_id,
            AssignmentProposal.recommended_owner_user_id == data.recommended_owner_user_id,
            AssignmentProposal.project_id == data.project_id,
            AssignmentProposal.status == AssignmentProposalStatus.owner_rejected,
        )
    ).first()
    if existing_rejected:
        raise ValueError(
            "(task, owner) pair was previously rejected; recommend a different owner"
        )


def create_assignment_proposal(session: Session, data: AssignmentProposalCreate, *, auto_commit: bool = True) -> AssignmentProposal:
    _validate_proposal_relationships(session, data)
    require_row(session, User, data.recommended_owner_user_id, "Recommended owner")
    if data.backup_owner_user_id:
        require_row(session, User, data.backup_owner_user_id, "Backup owner")

    proposal = AssignmentProposal(
        project_id=data.project_id,
        stage_id=data.stage_id,
        task_id=data.task_id,
        recommended_owner_user_id=data.recommended_owner_user_id,
        backup_owner_user_id=data.backup_owner_user_id,
        reason=data.reason,
        skill_match=data.skill_match,
        availability_match=data.availability_match,
        preference_match=data.preference_match,
        constraint_respected=data.constraint_respected,
        risk_note=data.risk_note,
        created_by_agent=data.created_by_agent,
    )
    session.add(proposal)
    if auto_commit:
        session.commit()
        session.refresh(proposal)
    else:
        session.flush()
    return proposal


def get_assignment_proposal(session: Session, proposal_id: str) -> AssignmentProposal | None:
    return session.get(AssignmentProposal, proposal_id)


def list_assignment_proposals_by_project(session: Session, project_id: str) -> list[AssignmentProposal]:
    return list(
        session.exec(
            select(AssignmentProposal).where(AssignmentProposal.project_id == project_id)
        ).all()
    )


def list_assignment_responses_by_project(session: Session, project_id: str) -> list[AssignmentResponse]:
    proposal_ids = [
        proposal.id for proposal in list_assignment_proposals_by_project(session, project_id)
    ]
    if not proposal_ids:
        return []
    return list(
        session.exec(
            select(AssignmentResponse).where(AssignmentResponse.proposal_id.in_(proposal_ids))
        ).all()
    )


def list_assignment_negotiations_by_project(
    session: Session,
    project_id: str,
) -> list[AssignmentNegotiation]:
    return list(
        session.exec(
            select(AssignmentNegotiation).where(AssignmentNegotiation.project_id == project_id)
        ).all()
    )


def create_assignment_response(
    session: Session,
    proposal_id: str,
    data: AssignmentResponseCreate,
) -> AssignmentResponse:
    proposal = require_row(session, AssignmentProposal, proposal_id, "Assignment proposal")
    require_row(session, User, data.user_id, "User")

    # Only proposed proposals can be responded to
    if proposal.status != AssignmentProposalStatus.proposed:
        status_display = proposal.status.value if isinstance(proposal.status, AssignmentProposalStatus) else proposal.status
        raise ValueError(
            f"当前提案状态为 {status_display}，无法回复；"
            f"只有 proposed 状态的提案接受回复"
        )

    if data.user_id != proposal.recommended_owner_user_id:
        raise ValueError("Only the recommended owner can respond to this proposal")

    # Accept must NOT have preferred_task_id
    if data.response == AssignmentResponseType.accept and data.preferred_task_id:
        raise ValueError("Accept response must not include preferred_task_id")

    # Reject must have a reason
    if data.response == AssignmentResponseType.reject:
        if not data.reason:
            raise ValueError("Reject response must include a reason")

    if data.preferred_task_id:
        require_row(session, Task, data.preferred_task_id, "Preferred task")
        # Verify preferred task belongs to same project
        task = session.get(Task, data.preferred_task_id)
        if task and task.project_id != proposal.project_id:
            raise ValueError("Preferred task does not belong to the same project")

    response = AssignmentResponse(
        proposal_id=proposal_id,
        user_id=data.user_id,
        response=data.response,
        preferred_task_id=data.preferred_task_id,
        reason=data.reason,
    )
    if data.response == AssignmentResponseType.accept:
        proposal.status = AssignmentProposalStatus.owner_confirmed
    else:
        proposal.status = AssignmentProposalStatus.owner_rejected

    session.add(response)
    session.add(proposal)
    session.commit()
    session.refresh(response)
    return response


def finalize_assignment_proposal(session: Session, proposal_id: str) -> AssignmentProposal:
    proposal = require_row(session, AssignmentProposal, proposal_id, "Assignment proposal")
    if proposal.status != AssignmentProposalStatus.owner_confirmed:
        raise ValueError("Assignment proposal must be owner_confirmed before finalization")

    task = require_row(session, Task, proposal.task_id, "Task")
    task.owner_user_id = proposal.recommended_owner_user_id
    task.backup_owner_user_id = proposal.backup_owner_user_id
    task.assignment_reason = proposal.reason
    task.updated_at = datetime.now(UTC)
    proposal.status = AssignmentProposalStatus.finalized

    session.add(task)
    session.add(proposal)
    session.commit()
    session.refresh(proposal)
    return proposal


def finalize_assignment_proposals_by_stage(session: Session, stage_id: str) -> list[AssignmentProposal]:
    require_row(session, Stage, stage_id, "Stage")
    proposals = list(
        session.exec(
            select(AssignmentProposal).where(
                AssignmentProposal.stage_id == stage_id,
                AssignmentProposal.status == AssignmentProposalStatus.owner_confirmed,
            )
        ).all()
    )

    # Check for task ownership conflicts before writing
    for proposal in proposals:
        task = require_row(session, Task, proposal.task_id, "Task")
        if task.owner_user_id is not None and task.owner_user_id != proposal.recommended_owner_user_id:
            raise ValueError(
                f"Task {proposal.task_id} already has owner {task.owner_user_id} "
                f"and cannot be reassigned to {proposal.recommended_owner_user_id} via this proposal"
            )

    for proposal in proposals:
        task = require_row(session, Task, proposal.task_id, "Task")
        task.owner_user_id = proposal.recommended_owner_user_id
        task.backup_owner_user_id = proposal.backup_owner_user_id
        task.assignment_reason = proposal.reason
        task.updated_at = datetime.now(UTC)
        proposal.status = AssignmentProposalStatus.finalized
        session.add(task)
        session.add(proposal)
    session.commit()
    for proposal in proposals:
        session.refresh(proposal)
    return proposals


def create_assignment_negotiation_from_proposal(
    session: Session,
    proposal_id: str,
    data: AssignmentNegotiationFromProposalCreate,
) -> AssignmentNegotiation:
    """Create a negotiation from a rejected proposal, generating a readable message.

    The agent_message uses member display names and task titles instead of raw IDs.
    """
    proposal = require_row(session, AssignmentProposal, proposal_id, "Assignment proposal")
    require_row(session, User, data.from_user_id, "Requester")
    desired_task = require_row(session, Task, data.desired_task_id, "Desired task")

    # Only owner_rejected proposals can start a negotiation
    if proposal.status != AssignmentProposalStatus.owner_rejected:
        status_display = proposal.status.value if isinstance(proposal.status, AssignmentProposalStatus) else proposal.status
        raise ValueError(
            f"Cannot create negotiation for proposal in status {status_display}; "
            f"only proposals with status 'owner_rejected' accept negotiations"
        )

    # Validate that desired_task belongs to same project as proposal
    if desired_task.project_id != proposal.project_id:
        raise ValueError("Desired task does not belong to the same project as the proposal")

    # from_user_id must match proposal's recommended owner
    if data.from_user_id != proposal.recommended_owner_user_id:
        raise ValueError("Only the proposal's recommended owner can create a negotiation")

    # Look up display names and task titles from the DB
    from_user = require_row(session, User, data.from_user_id, "From user")
    from_name = from_user.display_name

    # Find the proposal's task title
    proposal_task = require_row(session, Task, proposal.task_id, "Task")
    proposal_task_title = proposal_task.title

    desired_task_title = desired_task.title
    desired_task_owner_id = desired_task.owner_user_id

    # Build user-readable agent_message
    if desired_task_owner_id:
        desired_owner = session.get(User, desired_task_owner_id)
        desired_owner_name = desired_owner.display_name if desired_owner else "未知成员"
        agent_message = (
            f"{from_name} 拒绝「{proposal_task_title}」后，希望改做「{desired_task_title}」。"
            f"该任务当前由 {desired_owner_name} 负责，建议先确认是否愿意交换。"
        )
    else:
        agent_message = (
            f"{from_name} 拒绝「{proposal_task_title}」后，希望改做「{desired_task_title}」。"
            f"该任务当前未分配，负责人可以直接调整或重新运行分工推荐。"
        )

    negotiation = AssignmentNegotiation(
        project_id=proposal.project_id,
        stage_id=proposal.stage_id,
        from_user_id=data.from_user_id,
        desired_task_id=data.desired_task_id,
        current_owner_user_id=desired_task_owner_id,
        agent_message=agent_message,
    )
    session.add(negotiation)
    session.commit()
    session.refresh(negotiation)
    return negotiation


def create_assignment_negotiation(
    session: Session,
    data: AssignmentNegotiationCreate,
) -> AssignmentNegotiation:
    require_row(session, Project, data.project_id, "Project")
    require_row(session, Stage, data.stage_id, "Stage")
    require_row(session, User, data.from_user_id, "Requester")
    require_row(session, Task, data.desired_task_id, "Desired task")
    if data.current_owner_user_id:
        require_row(session, User, data.current_owner_user_id, "Current owner")

    negotiation = AssignmentNegotiation(
        project_id=data.project_id,
        stage_id=data.stage_id,
        from_user_id=data.from_user_id,
        desired_task_id=data.desired_task_id,
        current_owner_user_id=data.current_owner_user_id,
        agent_message=data.agent_message,
    )
    session.add(negotiation)
    session.commit()
    session.refresh(negotiation)
    return negotiation
