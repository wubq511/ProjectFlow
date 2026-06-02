import json
from datetime import UTC, datetime

from sqlmodel import Session, select

from app.core.db_utils import require_row
from app.agent.output_schemas import (
    DirectionCardOutput,
    StagePlanOutput,
    TaskBreakdownOutput,
)
from app.models import AgentEvent, AgentProposal, Project, Stage, Task, User
from app.models.enums import AgentEventType, AgentProposalStatus, ProjectStatus, StageStatus


def create_proposal(
    session: Session,
    *,
    project_id: str,
    workspace_id: str,
    proposal_type: str,
    agent_event_id: str,
    payload: dict,
    auto_commit: bool = True,
) -> AgentProposal:
    require_row(session, Project, project_id, "Project")
    require_row(session, AgentEvent, agent_event_id, "AgentEvent")

    proposal = AgentProposal(
        project_id=project_id,
        workspace_id=workspace_id,
        proposal_type=proposal_type,
        status=AgentProposalStatus.pending,
        agent_event_id=agent_event_id,
        payload=json.dumps(payload) if not isinstance(payload, str) else payload,
    )
    session.add(proposal)
    if auto_commit:
        session.commit()
        session.refresh(proposal)
    else:
        session.flush()
    return proposal


def get_proposal(session: Session, proposal_id: str) -> AgentProposal | None:
    return session.get(AgentProposal, proposal_id)


def list_proposals_by_project(
    session: Session,
    project_id: str,
    proposal_type: str | None = None,
) -> list[AgentProposal]:
    query = select(AgentProposal).where(AgentProposal.project_id == project_id)
    if proposal_type:
        query = query.where(AgentProposal.proposal_type == proposal_type)
    return list(session.exec(query).all())


def confirm_proposal(
    session: Session,
    proposal_id: str,
    confirmed_by: str,
) -> AgentProposal:
    """Confirm a pending proposal and persist its payload to project state.

    This is the core confirm-to-persist function:
    - Validates proposal is pending
    - Persists payload to actual project state based on proposal_type
    - Marks proposal as confirmed
    - Marks source AgentEvent as user_confirmed
    - Records a timeline AgentEvent for the confirmation
    """
    proposal = require_row(session, AgentProposal, proposal_id, "Agent proposal")
    if proposal.status != AgentProposalStatus.pending:
        raise ValueError(f"Proposal is {proposal.status.value}, cannot confirm")

    require_row(session, User, confirmed_by, "User")

    # Persist to project state based on type
    created_ids: list[str] = []
    if proposal.proposal_type == "clarify":
        created_ids = _persist_clarification(session, proposal)
    elif proposal.proposal_type == "plan":
        created_ids = _persist_stage_plan(session, proposal)
    elif proposal.proposal_type == "breakdown":
        created_ids = _persist_task_breakdown(session, proposal)
    else:
        raise ValueError(f"Unknown proposal type: {proposal.proposal_type}")

    # Mark proposal confirmed
    proposal.status = AgentProposalStatus.confirmed
    proposal.confirmed_by = confirmed_by
    proposal.confirmed_at = datetime.now(UTC)
    session.add(proposal)

    # Mark source agent event as confirmed
    agent_event = session.get(AgentEvent, proposal.agent_event_id)
    if agent_event is not None:
        agent_event.user_confirmed = True
        session.add(agent_event)

    # Record confirmation timeline event
    payload = _get_payload(proposal)
    reason = payload.get("reason", "")
    confirmation_event = AgentEvent(
        project_id=proposal.project_id,
        workspace_id=proposal.workspace_id,
        event_type=AgentEventType(proposal.proposal_type),
        input_snapshot=json.dumps({
            "action": "confirm_proposal",
            "proposal_id": proposal_id,
            "source_agent_event_id": proposal.agent_event_id,
        }, ensure_ascii=False),
        output_snapshot=json.dumps({
            "proposal_type": proposal.proposal_type,
            "confirmed_by": confirmed_by,
            "created_ids": created_ids,
            "reason": reason,
        }, ensure_ascii=False),
        reasoning_summary=f"User confirmed {proposal.proposal_type} proposal {proposal_id}: {reason}",
        user_confirmed=True,
    )
    session.add(confirmation_event)

    session.commit()
    session.refresh(proposal)
    return proposal


def reject_proposal(session: Session, proposal_id: str, reason: str | None = None) -> AgentProposal:
    """Reject a pending proposal. No state mutation occurs."""
    proposal = require_row(session, AgentProposal, proposal_id, "Agent proposal")
    if proposal.status != AgentProposalStatus.pending:
        raise ValueError(f"Proposal is {proposal.status.value}, cannot reject")

    proposal.status = AgentProposalStatus.rejected
    proposal.rejection_reason = reason
    session.add(proposal)
    session.commit()
    session.refresh(proposal)
    return proposal


def _get_payload(proposal: AgentProposal) -> dict:
    """Parse the proposal payload (may be a JSON string or dict)."""
    if isinstance(proposal.payload, str):
        return json.loads(proposal.payload)
    return proposal.payload


def _persist_clarification(session: Session, proposal: AgentProposal) -> list[str]:
    """Persist clarification output to Project.direction_card."""
    project = require_row(session, Project, proposal.project_id, "Project")
    payload = _get_payload(proposal)
    output = DirectionCardOutput.model_validate(payload)
    direction_card = {
        "problem": output.problem,
        "users": output.users,
        "value": output.value,
        "deliverables": output.deliverables,
        "boundaries": output.boundaries,
        "risks": output.risks,
        "suggested_questions": output.suggested_questions,
    }
    project.direction_card = json.dumps(direction_card, ensure_ascii=False)
    project.updated_at = datetime.now(UTC)
    session.add(project)
    return [project.id]


def _persist_stage_plan(session: Session, proposal: AgentProposal) -> list[str]:
    """Persist stage plan output and activate the first stage when needed."""
    project = require_row(session, Project, proposal.project_id, "Project")
    payload = _get_payload(proposal)
    output = StagePlanOutput.model_validate(payload)
    existing_active = session.exec(
        select(Stage).where(
            Stage.project_id == proposal.project_id,
            Stage.status == StageStatus.active.value,
        )
    ).first()
    should_activate_first = existing_active is None and project.current_stage_id is None

    created_ids: list[str] = []
    active_stage_id: str | None = None
    for index, stage_item in enumerate(sorted(output.stages, key=lambda item: item.order_index)):
        activate_this_stage = should_activate_first and index == 0
        stage = Stage(
            project_id=proposal.project_id,
            name=stage_item.name,
            goal=stage_item.goal,
            start_date=stage_item.start_date.isoformat(),
            end_date=stage_item.end_date.isoformat(),
            deliverable=stage_item.deliverable,
            done_criteria=json.dumps(stage_item.done_criteria, ensure_ascii=False),
            order_index=stage_item.order_index,
            status=StageStatus.active.value if activate_this_stage else StageStatus.pending.value,
        )
        session.add(stage)
        session.flush()
        created_ids.append(stage.id)
        if activate_this_stage:
            active_stage_id = stage.id

    if active_stage_id:
        project.current_stage_id = active_stage_id
        project.status = ProjectStatus.active.value
        project.updated_at = datetime.now(UTC)
        session.add(project)

    return created_ids


def _persist_task_breakdown(session: Session, proposal: AgentProposal) -> list[str]:
    """Persist task breakdown output by creating Task records."""
    payload = _get_payload(proposal)
    output = TaskBreakdownOutput.model_validate(payload)
    created_ids: list[str] = []
    for task_item in output.tasks:
        task = Task(
            project_id=proposal.project_id,
            stage_id=task_item.stage_id or "",
            title=task_item.title,
            description=task_item.description,
            priority=task_item.priority.value,
            due_date=task_item.due_date.isoformat(),
            estimated_hours=task_item.estimated_hours,
            dependency_ids=json.dumps(task_item.dependency_ids, ensure_ascii=False),
            acceptance_criteria=json.dumps(task_item.acceptance_criteria, ensure_ascii=False),
            can_cut=task_item.can_cut,
            created_by_agent=True,
        )
        session.add(task)
        session.flush()
        created_ids.append(task.id)
    return created_ids
