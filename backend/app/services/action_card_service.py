from sqlmodel import Session, select

from app.models import ActionCard, Project, Stage, Task, User
from app.schemas.action_card import ActionCardCreate


def create_action_card(session: Session, data: ActionCardCreate) -> ActionCard:
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
        due_date=data.due_date,
        created_by_agent=data.created_by_agent,
    )
    session.add(card)
    session.commit()
    session.refresh(card)
    return card


def list_action_cards_by_project(session: Session, project_id: str) -> list[ActionCard]:
    return list(session.exec(select(ActionCard).where(ActionCard.project_id == project_id)).all())


def _validate_action_card_refs(session: Session, data: ActionCardCreate) -> None:
    _require(session, Project, data.project_id, "Project")
    if data.stage_id:
        _require(session, Stage, data.stage_id, "Stage")
    if data.task_id:
        _require(session, Task, data.task_id, "Task")
    if data.user_id:
        _require(session, User, data.user_id, "User")


def _require(session: Session, model: type, row_id: str, label: str):
    row = session.get(model, row_id)
    if row is None:
        raise ValueError(f"{label} not found")
    return row
