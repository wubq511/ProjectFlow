from sqlmodel import Session, select

from app.models.stage import Stage
from app.schemas.stage import StageCreate, StageUpdate


def create_stage(session: Session, data: StageCreate) -> Stage:
    stage = Stage(
        project_id=data.project_id,
        name=data.name,
        goal=data.goal,
        start_date=data.start_date,
        end_date=data.end_date,
        deliverable=data.deliverable,
        done_criteria=data.done_criteria if data.done_criteria is not None else [],
        order_index=data.order_index if data.order_index is not None else 0,
    )
    session.add(stage)
    session.commit()
    session.refresh(stage)
    return stage


def get_stage(session: Session, stage_id: str) -> Stage | None:
    return session.get(Stage, stage_id)


def list_stages_by_project(session: Session, project_id: str) -> list[Stage]:
    return list(
        session.exec(select(Stage).where(Stage.project_id == project_id)).all()
    )


def update_stage(session: Session, stage_id: str, data: StageUpdate) -> Stage:
    stage = session.get(Stage, stage_id)
    if stage is None:
        raise ValueError(f"Stage {stage_id} not found")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(stage, key, value)

    session.add(stage)
    session.commit()
    session.refresh(stage)
    return stage
