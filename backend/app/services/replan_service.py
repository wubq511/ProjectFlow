from datetime import UTC, datetime

from sqlmodel import Session, select

from app.core.db_utils import require_row
from app.models import ActionCard, AssignmentProposal, Project, Stage, Task, User
from app.models.enums import AssignmentProposalStatus
from app.schemas.replan import ReplanConfirmRead, ReplanConfirmRequest


def confirm_replan(
    session: Session,
    data: ReplanConfirmRequest,
    *,
    auto_commit: bool = True,
) -> ReplanConfirmRead:
    if not data.requires_confirmation:
        raise ValueError("Replan confirmation requires a proposal marked requires_confirmation")

    require_row(session, Project, data.project_id, "Project")
    applied_stage_ids: list[str] = []
    applied_task_ids: list[str] = []
    created_action_card_ids: list[str] = []

    for adjustment in data.stage_adjustments:
        stage = require_row(session, Stage, adjustment.stage_id, "Stage")
        if stage.project_id != data.project_id:
            raise ValueError("Stage does not belong to project")
        if adjustment.new_start_date is not None:
            stage.start_date = adjustment.new_start_date
        if adjustment.new_end_date is not None:
            stage.end_date = adjustment.new_end_date
        session.add(stage)
        applied_stage_ids.append(stage.id)

    for change in data.task_changes:
        task = require_row(session, Task, change.task_id, "Task")
        if task.project_id != data.project_id:
            raise ValueError("Task does not belong to project")
        # Guard: do not change owner on a task with a finalized assignment
        if change.owner_user_id is not None and change.owner_user_id != task.owner_user_id:
            finalized_proposal = session.exec(
                select(AssignmentProposal).where(
                    AssignmentProposal.task_id == change.task_id,
                    AssignmentProposal.status == AssignmentProposalStatus.finalized,
                )
            ).first()
            if finalized_proposal:
                raise ValueError(
                    f"Cannot change owner of task {change.task_id}: "
                    f"it has a finalized assignment (proposal {finalized_proposal.id}). "
                    f"Reject the assignment first before reassigning."
                )
        if change.title is not None:
            task.title = change.title
        if change.status is not None:
            task.status = change.status
        if change.owner_user_id is not None:
            require_row(session, User, change.owner_user_id, "Task owner")
            task.owner_user_id = change.owner_user_id
        if change.due_date is not None:
            task.due_date = change.due_date
        if change.can_cut is not None:
            task.can_cut = change.can_cut
        task.updated_at = datetime.now(UTC)
        session.add(task)
        applied_task_ids.append(task.id)

    for card_data in data.action_cards:
        if card_data.project_id != data.project_id:
            raise ValueError("Action card does not belong to project")
        card = ActionCard(
            project_id=card_data.project_id,
            stage_id=card_data.stage_id,
            user_id=card_data.user_id,
            task_id=card_data.task_id,
            type=card_data.type,
            title=card_data.title,
            content=card_data.content,
            reason=card_data.reason,
            goal=card_data.goal,
            start_suggestion=card_data.start_suggestion,
            completion_standard=card_data.completion_standard,
            due_date=card_data.due_date,
            evidence_refs=[ref.model_dump(mode="json") for ref in card_data.evidence_refs],
            created_by_agent=card_data.created_by_agent,
        )
        session.add(card)
        session.flush()
        created_action_card_ids.append(card.id)

    result = ReplanConfirmRead(
        confirmed=True,
        project_id=data.project_id,
        before=data.before,
        after=data.after,
        impact=data.impact,
        reason=data.reason,
        requires_confirmation=data.requires_confirmation,
        applied_stage_ids=applied_stage_ids,
        applied_task_ids=applied_task_ids,
        created_action_card_ids=created_action_card_ids,
    )
    if auto_commit:
        session.commit()
    else:
        session.flush()
    return result
