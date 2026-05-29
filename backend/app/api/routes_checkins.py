from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.checkin import (
    CheckInCycleCreate,
    CheckInCycleRead,
    CheckInResponseCreate,
    CheckInResponseRead,
)
from app.services.checkin_service import (
    create_checkin_cycle,
    create_checkin_response,
    list_checkin_cycles_by_project,
    list_checkin_responses_by_cycle,
)

router = APIRouter(tags=["check-ins"])


@router.post("/checkin-cycles", response_model=CheckInCycleRead, status_code=201)
def api_create_checkin_cycle(
    data: CheckInCycleCreate,
    session: Session = Depends(get_session),
):
    try:
        return create_checkin_cycle(session, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/projects/{project_id}/checkin-cycles", response_model=list[CheckInCycleRead])
def api_list_checkin_cycles_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_checkin_cycles_by_project(session, project_id)


@router.post(
    "/checkin-cycles/{cycle_id}/responses",
    response_model=CheckInResponseRead,
    status_code=201,
)
def api_create_checkin_response(
    cycle_id: str,
    data: CheckInResponseCreate,
    session: Session = Depends(get_session),
):
    try:
        return create_checkin_response(session, cycle_id, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/checkin-cycles/{cycle_id}/responses", response_model=list[CheckInResponseRead])
def api_list_checkin_responses_by_cycle(
    cycle_id: str,
    session: Session = Depends(get_session),
):
    return list_checkin_responses_by_cycle(session, cycle_id)
