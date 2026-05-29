from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.replan import ReplanConfirmRead, ReplanConfirmRequest
from app.services.replan_service import confirm_replan

router = APIRouter(tags=["replans"])


@router.post("/replans/confirm", response_model=ReplanConfirmRead)
def api_confirm_replan(
    data: ReplanConfirmRequest,
    session: Session = Depends(get_session),
):
    try:
        return confirm_replan(session, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
