from datetime import timedelta

from sqlmodel import Session, select

from app.models import CheckInCycle, CheckInResponse, Project, Stage, Task, User
from app.schemas.checkin import CheckInCycleCreate, CheckInResponseCreate


def create_checkin_cycle(session: Session, data: CheckInCycleCreate) -> CheckInCycle:
    if data.cadence_days < 1:
        raise ValueError("cadence_days must be at least 1")
    _require(session, Project, data.project_id, "Project")
    _require(session, Stage, data.stage_id, "Stage")
    _require(session, User, data.created_by_user_id, "Creator")

    cycle = CheckInCycle(
        project_id=data.project_id,
        stage_id=data.stage_id,
        cadence_days=data.cadence_days,
        start_date=data.start_date,
        next_due_date=data.start_date + timedelta(days=data.cadence_days),
        created_by_user_id=data.created_by_user_id,
    )
    session.add(cycle)
    session.commit()
    session.refresh(cycle)
    return cycle


def list_checkin_cycles_by_project(session: Session, project_id: str) -> list[CheckInCycle]:
    return list(session.exec(select(CheckInCycle).where(CheckInCycle.project_id == project_id)).all())


def create_checkin_response(
    session: Session,
    cycle_id: str,
    data: CheckInResponseCreate,
) -> CheckInResponse:
    cycle = _require(session, CheckInCycle, cycle_id, "Check-in cycle")
    _require(session, Project, data.project_id, "Project")
    _require(session, Stage, data.stage_id, "Stage")
    _require(session, User, data.user_id, "User")
    if data.task_id:
        _require(session, Task, data.task_id, "Task")
    if cycle.project_id != data.project_id or cycle.stage_id != data.stage_id:
        raise ValueError("Check-in response must match cycle project and stage")

    response = CheckInResponse(
        cycle_id=cycle_id,
        project_id=data.project_id,
        stage_id=data.stage_id,
        user_id=data.user_id,
        task_id=data.task_id,
        what_done=data.what_done,
        blocker=data.blocker,
        available_hours_next_cycle=data.available_hours_next_cycle,
        mood_or_confidence=data.mood_or_confidence,
    )
    session.add(response)
    session.commit()
    session.refresh(response)
    return response


def list_checkin_responses_by_cycle(session: Session, cycle_id: str) -> list[CheckInResponse]:
    return list(session.exec(select(CheckInResponse).where(CheckInResponse.cycle_id == cycle_id)).all())


def _require(session: Session, model: type, row_id: str, label: str):
    row = session.get(model, row_id)
    if row is None:
        raise ValueError(f"{label} not found")
    return row
