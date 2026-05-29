from sqlmodel import Session, select

from app.models import Project, Risk, Stage, Task
from app.schemas.risk import RiskCreate


def create_risk(session: Session, data: RiskCreate) -> Risk:
    if not data.evidence:
        raise ValueError("Risk evidence is required")
    _require(session, Project, data.project_id, "Project")
    if data.stage_id:
        _require(session, Stage, data.stage_id, "Stage")
    if data.task_id:
        _require(session, Task, data.task_id, "Task")

    risk = Risk(
        project_id=data.project_id,
        stage_id=data.stage_id,
        task_id=data.task_id,
        type=data.type,
        severity=data.severity,
        title=data.title,
        description=data.description,
        evidence=data.evidence,
        recommendation=data.recommendation,
        created_by_agent=data.created_by_agent,
    )
    session.add(risk)
    session.commit()
    session.refresh(risk)
    return risk


def list_risks_by_project(session: Session, project_id: str) -> list[Risk]:
    return list(session.exec(select(Risk).where(Risk.project_id == project_id)).all())


def _require(session: Session, model: type, row_id: str, label: str):
    row = session.get(model, row_id)
    if row is None:
        raise ValueError(f"{label} not found")
    return row
