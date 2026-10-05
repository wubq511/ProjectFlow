from sqlmodel import Session, select

from app.core.db_utils import require_row
from app.models import ActionCard, Project, Stage, Task, User
from app.models.enums import ActionCardStatus
from app.schemas.action_card import ActionCardCreate


def create_action_card(session: Session, data: ActionCardCreate, *, auto_commit: bool = True) -> ActionCard:
    _validate_action_card_refs(session, data)
    card = ActionCard(
        project_id=data.project_id,
        stage_id=data.stage_id,
        user_id=data.user_id,
        task_id=data.task_id,
        type=data.type,
        title=data.title,
        content=data.content,
        reason=data.reason,
        goal=data.goal,
        start_suggestion=data.start_suggestion,
        completion_standard=data.completion_standard,
        due_date=data.due_date,
        evidence_refs=[ref.model_dump(mode="json") for ref in data.evidence_refs],
        created_by_agent=data.created_by_agent,
    )
    session.add(card)
    if auto_commit:
        session.commit()
        session.refresh(card)
    else:
        session.flush()
    return card


def list_action_cards_by_project(session: Session, project_id: str) -> list[ActionCard]:
    return list(session.exec(select(ActionCard).where(ActionCard.project_id == project_id)).all())


def update_action_card_status(
    session: Session,
    card_id: str,
    status: ActionCardStatus,
) -> ActionCard:
    card = session.get(ActionCard, card_id)
    if card is None:
        raise ValueError("Action card not found")
    card.status = status
    session.add(card)
    session.commit()
    session.refresh(card)
    return card


def _validate_action_card_refs(session: Session, data: ActionCardCreate) -> None:
    require_row(session, Project, data.project_id, "Project")
    if data.stage_id:
        require_row(session, Stage, data.stage_id, "Stage")
    if data.task_id:
        require_row(session, Task, data.task_id, "Task")
    if data.user_id:
        require_row(session, User, data.user_id, "User")
