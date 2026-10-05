import json

from sqlmodel import Session, select

from app.core.db_utils import require_row
from app.models import Project, Risk, Stage, Task
from app.models.enums import RiskStatus
from app.schemas.risk import RiskCreate


def create_risk(session: Session, data: RiskCreate, *, auto_commit: bool = True) -> Risk:
    if not data.evidence:
        raise ValueError("Risk evidence is required")
    require_row(session, Project, data.project_id, "Project")
    if data.stage_id:
        require_row(session, Stage, data.stage_id, "Stage")
    if data.task_id:
        require_row(session, Task, data.task_id, "Task")

    # Dedup: skip if an open/accepted risk already exists for the same task+type combination
    if data.task_id and data.type:
        existing = session.exec(
            select(Risk).where(
                Risk.project_id == data.project_id,
                Risk.task_id == data.task_id,
                Risk.type == data.type,
                Risk.status.in_([RiskStatus.open, RiskStatus.accepted]),
            )
        ).first()
        if existing is not None:
            return existing

    risk = Risk(
        project_id=data.project_id,
        stage_id=data.stage_id,
        task_id=data.task_id,
        type=data.type,
        severity=data.severity,
        title=data.title,
        description=data.description,
        evidence=json.dumps(data.evidence, ensure_ascii=False),
        evidence_refs=[ref.model_dump(mode="json") for ref in data.evidence_refs],
        recommendation=data.recommendation,
        created_by_agent=data.created_by_agent,
    )
    session.add(risk)
    if auto_commit:
        session.commit()
        session.refresh(risk)
    else:
        session.flush()
    return risk


def list_risks_by_project(session: Session, project_id: str) -> list[Risk]:
    return list(session.exec(select(Risk).where(Risk.project_id == project_id)).all())


def update_risk_status(session: Session, risk_id: str, status: RiskStatus) -> Risk:
    risk = session.get(Risk, risk_id)
    if risk is None:
        raise ValueError("Risk not found")
    risk.status = status
    session.add(risk)
    session.commit()
    session.refresh(risk)
    return risk
