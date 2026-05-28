from datetime import UTC, datetime

from sqlmodel import Session, select

from app.models.task import Task, TaskStatusUpdate
from app.schemas.task import TaskCreate, TaskUpdate, TaskStatusUpdateCreate


def create_task(session: Session, data: TaskCreate) -> Task:
    task = Task(
        project_id=data.project_id,
        stage_id=data.stage_id,
        title=data.title,
        description=data.description,
        priority=data.priority,
        due_date=data.due_date,
        estimated_hours=data.estimated_hours,
        can_cut=data.can_cut,
    )
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


def get_task(session: Session, task_id: str) -> Task | None:
    return session.get(Task, task_id)


def list_tasks_by_stage(session: Session, stage_id: str) -> list[Task]:
    return list(session.exec(select(Task).where(Task.stage_id == stage_id)).all())


def list_tasks_by_project(session: Session, project_id: str) -> list[Task]:
    return list(session.exec(select(Task).where(Task.project_id == project_id)).all())


def update_task(session: Session, task_id: str, data: TaskUpdate) -> Task:
    task = session.get(Task, task_id)
    if task is None:
        raise ValueError(f"Task {task_id} not found")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(task, key, value)
    task.updated_at = datetime.now(UTC)

    session.add(task)
    session.commit()
    session.refresh(task)
    return task


def create_status_update(session: Session, data: TaskStatusUpdateCreate) -> TaskStatusUpdate:
    status_update = TaskStatusUpdate(
        task_id=data.task_id,
        user_id=data.user_id,
        status=data.status,
        progress_note=data.progress_note,
        blocker=data.blocker,
    )
    session.add(status_update)
    session.commit()
    session.refresh(status_update)
    return status_update
