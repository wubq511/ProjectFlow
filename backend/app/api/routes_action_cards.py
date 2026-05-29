from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.action_card import ActionCardCreate, ActionCardRead
from app.services.action_card_service import create_action_card, list_action_cards_by_project

router = APIRouter(tags=["action-cards"])


@router.post("/action-cards", response_model=ActionCardRead, status_code=201)
def api_create_action_card(
    data: ActionCardCreate,
    session: Session = Depends(get_session),
):
    try:
        return create_action_card(session, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/projects/{project_id}/action-cards", response_model=list[ActionCardRead])
def api_list_action_cards_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_action_cards_by_project(session, project_id)
