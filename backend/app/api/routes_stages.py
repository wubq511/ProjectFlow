from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.stage import StageCreate, StageUpdate, StageRead
from app.services.stage_service import (
    create_stage,
    get_stage,
    list_stages_by_project,
    update_stage,
)

router = APIRouter(tags=["stages"])


@router.post("/stages", response_model=StageRead, status_code=201)
def api_create_stage(
    data: StageCreate,
    session: Session = Depends(get_session),
):
    return create_stage(session, data)


@router.get("/stages/{stage_id}", response_model=StageRead)
def api_get_stage(
    stage_id: str,
    session: Session = Depends(get_session),
):
    stage = get_stage(session, stage_id)
    if stage is None:
        raise HTTPException(status_code=404, detail="Stage not found")
    return stage


@router.get("/projects/{project_id}/stages", response_model=list[StageRead])
def api_list_stages_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_stages_by_project(session, project_id)


@router.patch("/stages/{stage_id}", response_model=StageRead)
def api_update_stage(
    stage_id: str,
    data: StageUpdate,
    session: Session = Depends(get_session),
):
    try:
        return update_stage(session, stage_id, data)
    except ValueError:
        raise HTTPException(status_code=404, detail="Stage not found")
