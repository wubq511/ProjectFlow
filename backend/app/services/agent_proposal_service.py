import json
from datetime import UTC, datetime

from sqlmodel import Session, select

from app.core.db_utils import require_row
from app.agent.output_schemas import (
    DirectionCardOutput,
    ReplanOutput,
    StagePlanOutput,
    TaskBreakdownOutput,
)
from app.models import AgentEvent, AgentProposal, Project, Stage, Task, User
from app.models.enums import AgentEventType, AgentProposalStatus, ProjectStatus, RuntimeEventType, StageStatus
from app.schemas.agent_proposal import AgentProposalRead
from app.schemas.runtime import AppendRequest, EventAppendItem
from app.services.agent_runtime_service import get_agent_runtime_service


def to_proposal_read(proposal: AgentProposal) -> AgentProposalRead:
    """Convert an AgentProposal model to AgentProposalRead, parsing JSON string fields."""
    payload = proposal.payload
    if isinstance(payload, str):
        payload = json.loads(payload)
    return AgentProposalRead(
        id=proposal.id,
        project_id=proposal.project_id,
        workspace_id=proposal.workspace_id,
        proposal_type=proposal.proposal_type,
        status=proposal.status,
        agent_event_id=proposal.agent_event_id,
        payload=payload,
        confirmed_by=proposal.confirmed_by,
        confirmed_at=proposal.confirmed_at,
        rejection_reason=proposal.rejection_reason,
        created_at=proposal.created_at,
    )


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
    status: str | None = None,
) -> list[AgentProposal]:
    query = select(AgentProposal).where(AgentProposal.project_id == project_id)
    if proposal_type:
        query = query.where(AgentProposal.proposal_type == proposal_type)
    if status:
        query = query.where(AgentProposal.status == status)
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
    elif proposal.proposal_type == "replan":
        created_ids = _persist_replan(session, proposal)
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

    _record_proposal_confirmation_runtime_events(
        session,
        proposal=proposal,
        event_types=[
            RuntimeEventType.proposal_confirmation_confirmed,
            RuntimeEventType.proposal_confirmation_committed,
        ],
        confirmed_by=confirmed_by,
        created_ids=created_ids,
    )

    session.commit()
    session.refresh(proposal)

    # ── ProjectMemory extraction hook ──
    # Runs AFTER the business decision commits; failures are absorbed.
    _source_type_map = {
        "clarify": "direction_card_confirmed",
        "replan": "replan_confirmed",
    }
    memory_source_type = _source_type_map.get(proposal.proposal_type)
    if memory_source_type:
        try:
            from app.services.memory_service import extract_from_event
            extract_from_event(
                source_type=memory_source_type,
                source_id=proposal.id,
            )
        except Exception:
            import logging as _logging
            _logging.getLogger(__name__).exception(
                "ProjectMemory extraction failed for %s %s",
                memory_source_type,
                proposal.id,
            )

    return proposal


def reject_proposal(session: Session, proposal_id: str, reason: str | None = None) -> AgentProposal:
    """Reject a pending proposal. No state mutation occurs.

    If reason is non-empty, ProjectMemory extraction runs after the business
    decision commits. Empty/None reason is tolerated for legacy compatibility
    but does not produce ProjectMemory.
    """
    proposal = require_row(session, AgentProposal, proposal_id, "Agent proposal")
    if proposal.status != AgentProposalStatus.pending:
        raise ValueError(f"Proposal is {proposal.status.value}, cannot reject")

    proposal.status = AgentProposalStatus.rejected
    proposal.rejection_reason = reason
    session.add(proposal)
    _record_proposal_confirmation_runtime_events(
        session,
        proposal=proposal,
        event_types=[RuntimeEventType.proposal_confirmation_rejected],
        rejection_reason=reason,
    )
    session.commit()
    session.refresh(proposal)

    # ── ProjectMemory extraction hook (proposal rejected / replan rejected) ──
    # Only extract when rejection_reason is non-empty.
    # Runs AFTER the business decision commits; failures are absorbed.
    # Does NOT create an AgentEvent.
    if reason and reason.strip():
        _rejection_source_type = "replan_rejected" if proposal.proposal_type == "replan" else "proposal_rejected"
        try:
            from app.services.memory_service import extract_from_event
            extract_from_event(
                source_type=_rejection_source_type,
                source_id=proposal.id,
            )
        except Exception:
            import logging as _logging
            _logging.getLogger(__name__).exception(
                "ProjectMemory extraction failed for %s %s",
                _rejection_source_type,
                proposal.id,
            )

    return proposal


def _get_payload(proposal: AgentProposal) -> dict:
    """Parse the proposal payload (may be a JSON string or dict)."""
    if isinstance(proposal.payload, str):
        return json.loads(proposal.payload)
    return proposal.payload


def _record_proposal_confirmation_runtime_events(
    session: Session,
    *,
    proposal: AgentProposal,
    event_types: list[RuntimeEventType],
    confirmed_by: str | None = None,
    rejection_reason: str | None = None,
    created_ids: list[str] | None = None,
) -> None:
    """Record S10 runtime confirmation events for proposals created by T41 tools."""
    context = _proposal_runtime_context(session, proposal)
    if context is None:
        return
    run_id = context["run_id"]
    service = get_agent_runtime_service(session)
    if service.get_run_status(run_id) is None:
        return

    events: list[EventAppendItem] = []
    for index, event_type in enumerate(event_types, start=1):
        payload = {
            "run_id": run_id,
            "conversation_id": context.get("conversation_id"),
            "workspace_id": proposal.workspace_id,
            "project_id": proposal.project_id,
            "proposal_id": proposal.id,
            "proposal_type": proposal.proposal_type,
            "source_agent_event_id": proposal.agent_event_id,
            "state_schema_version": 1,
        }
        if "tool_call_id" in context:
            payload["tool_call_id"] = context["tool_call_id"]
        if "tool_name" in context:
            payload["tool_name"] = context["tool_name"]
        if confirmed_by is not None:
            payload["confirmed_by"] = confirmed_by
        if rejection_reason is not None:
            payload["rejection_reason"] = rejection_reason
        if event_type == RuntimeEventType.proposal_confirmation_committed:
            payload["created_ids"] = created_ids or []

        events.append(EventAppendItem(
            client_event_id=f"{run_id}:{proposal.id}:{event_type.value}",
            type=event_type,
            ordering_hint=index,
            payload=payload,
            trace={
                "run_id": run_id,
                "conversation_id": context.get("conversation_id"),
                "workspace_id": proposal.workspace_id,
                "project_id": proposal.project_id,
                "proposal_id": proposal.id,
                **({"tool_call_id": context["tool_call_id"]} if "tool_call_id" in context else {}),
                **({"tool_name": context["tool_name"]} if "tool_name" in context else {}),
                "redacted": True,
            },
        ))

    service.append_events(
        run_id,
        AppendRequest(
            idempotency_key=f"{run_id}:proposal:{proposal.id}:{event_types[0].value}:v1",
            events=events,
        ),
    )


def _proposal_runtime_context(session: Session, proposal: AgentProposal) -> dict[str, str] | None:
    source_event = session.get(AgentEvent, proposal.agent_event_id)
    if source_event is None:
        return None
    snapshot = source_event.get_input_snapshot()
    if not isinstance(snapshot, dict):
        return None
    run_id = snapshot.get("tool_run_id") or snapshot.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        return None
    result = {"run_id": run_id}
    conversation_id = snapshot.get("conversation_id")
    if isinstance(conversation_id, str):
        result["conversation_id"] = conversation_id
    tool_call_id = snapshot.get("tool_call_id")
    if isinstance(tool_call_id, str):
        result["tool_call_id"] = tool_call_id
    tool_name = snapshot.get("tool_name")
    if isinstance(tool_name, str):
        result["tool_name"] = tool_name
    return result


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
    for task_item in sorted(output.tasks, key=lambda t: (t.order_index, t.priority, t.due_date)):
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
            order_index=task_item.order_index,
            created_by_agent=True,
        )
        session.add(task)
        session.flush()
        created_ids.append(task.id)
    return created_ids


def _persist_replan(session: Session, proposal: AgentProposal) -> list[str]:
    """Persist replan output by delegating to replan_service.confirm_replan."""
    from app.schemas.replan import ReplanConfirmRequest, ReplanStageAdjustment, ReplanTaskChange
    from app.schemas.action_card import ActionCardCreate
    from app.services.replan_service import confirm_replan

    payload = _get_payload(proposal)
    output = ReplanOutput.model_validate(payload)

    stage_adjustments = [
        ReplanStageAdjustment(
            stage_id=adj.stage_id,
            new_start_date=adj.new_start_date,
            new_end_date=adj.new_end_date,
            reason=adj.reason,
        )
        for adj in output.stage_adjustments
    ]
    task_changes = [
        ReplanTaskChange(
            task_id=tc.task_id,
            title=tc.title,
            status=tc.status,
            owner_user_id=tc.owner_user_id,
            due_date=tc.due_date,
            can_cut=tc.can_cut,
            reason=tc.reason,
        )
        for tc in output.task_changes
    ]
    action_cards = [
        ActionCardCreate(
            project_id=proposal.project_id,
            stage_id=card.stage_id,
            user_id=card.user_id,
            task_id=card.task_id,
            type=card.type,
            title=card.title,
            content=card.content,
            reason=card.reason,
            goal=card.goal,
            start_suggestion=card.start_suggestion,
            completion_standard=card.completion_standard,
            due_date=card.due_date,
            created_by_agent=True,
        )
        for card in output.action_cards
    ]

    request = ReplanConfirmRequest(
        project_id=proposal.project_id,
        before=output.before,
        after=output.after,
        impact=output.impact,
        reason=output.reason,
        requires_confirmation=output.requires_confirmation,
        stage_adjustments=stage_adjustments,
        task_changes=task_changes,
        action_cards=action_cards,
    )
    result = confirm_replan(session, request, auto_commit=False)
    return result.applied_stage_ids + result.applied_task_ids + result.created_action_card_ids
