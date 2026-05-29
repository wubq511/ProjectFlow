from datetime import UTC, datetime

from sqlmodel import Session, select

from app.models import (
    AssignmentNegotiation,
    AssignmentProposal,
    AssignmentResponse,
    Project,
    Stage,
    Task,
    User,
)
from app.models.enums import AssignmentProposalStatus, AssignmentResponseType
from app.schemas.assignment import (
    AssignmentNegotiationCreate,
    AssignmentProposalCreate,
    AssignmentResponseCreate,
)


def create_assignment_proposal(session: Session, data: AssignmentProposalCreate) -> AssignmentProposal:
    _require(session, Project, data.project_id, "Project")
    _require(session, Stage, data.stage_id, "Stage")
    _require(session, Task, data.task_id, "Task")
    _require(session, User, data.recommended_owner_user_id, "Recommended owner")
    if data.backup_owner_user_id:
        _require(session, User, data.backup_owner_user_id, "Backup owner")

    proposal = AssignmentProposal(
        project_id=data.project_id,
        stage_id=data.stage_id,
        task_id=data.task_id,
        recommended_owner_user_id=data.recommended_owner_user_id,
        backup_owner_user_id=data.backup_owner_user_id,
        reason=data.reason,
        risk_note=data.risk_note,
        created_by_agent=data.created_by_agent,
    )
    session.add(proposal)
    session.commit()
    session.refresh(proposal)
    return proposal


def get_assignment_proposal(session: Session, proposal_id: str) -> AssignmentProposal | None:
    return session.get(AssignmentProposal, proposal_id)


def list_assignment_proposals_by_project(session: Session, project_id: str) -> list[AssignmentProposal]:
    return list(
        session.exec(
            select(AssignmentProposal).where(AssignmentProposal.project_id == project_id)
        ).all()
    )


def create_assignment_response(
    session: Session,
    proposal_id: str,
    data: AssignmentResponseCreate,
) -> AssignmentResponse:
    proposal = _require(session, AssignmentProposal, proposal_id, "Assignment proposal")
    _require(session, User, data.user_id, "User")
    if data.user_id != proposal.recommended_owner_user_id:
        raise ValueError("Only the recommended owner can respond to this proposal")
    if data.preferred_task_id:
        _require(session, Task, data.preferred_task_id, "Preferred task")

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
    proposal = _require(session, AssignmentProposal, proposal_id, "Assignment proposal")
    if proposal.status != AssignmentProposalStatus.owner_confirmed:
        raise ValueError("Assignment proposal must be owner_confirmed before finalization")

    task = _require(session, Task, proposal.task_id, "Task")
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


def create_assignment_negotiation(
    session: Session,
    data: AssignmentNegotiationCreate,
) -> AssignmentNegotiation:
    _require(session, Project, data.project_id, "Project")
    _require(session, Stage, data.stage_id, "Stage")
    _require(session, User, data.from_user_id, "Requester")
    _require(session, Task, data.desired_task_id, "Desired task")
    if data.current_owner_user_id:
        _require(session, User, data.current_owner_user_id, "Current owner")

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


def _require(session: Session, model: type, row_id: str, label: str):
    row = session.get(model, row_id)
    if row is None:
        raise ValueError(f"{label} not found")
    return row
