from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.risk import RiskCreate, RiskRead
from app.services.risk_service import create_risk, list_risks_by_project

router = APIRouter(tags=["risks"])


@router.post("/risks", response_model=RiskRead, status_code=201)
def api_create_risk(
    data: RiskCreate,
    session: Session = Depends(get_session),
):
    try:
        return create_risk(session, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/projects/{project_id}/risks", response_model=list[RiskRead])
def api_list_risks_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_risks_by_project(session, project_id)
