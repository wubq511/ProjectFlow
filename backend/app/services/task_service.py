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
        priority=data.priority.value if hasattr(data.priority, "value") else data.priority,
        due_date=data.due_date.isoformat() if hasattr(data.due_date, "isoformat") else data.due_date,
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


def create_status_update(session: Session, task_id: str, data: TaskStatusUpdateCreate, *, auto_commit: bool = True) -> TaskStatusUpdate:
    # Create the history record
    status_update = TaskStatusUpdate(
        task_id=task_id,
        user_id=data.user_id,
        status=data.status,
        progress_note=data.progress_note,
        blocker=data.blocker,
        available_hours_change=data.available_hours_change,
    )
    session.add(status_update)

    # Also update the Task.status field so the task's current status reflects the change
    task = session.get(Task, task_id)
    if task is not None:
        task.status = data.status.value if hasattr(data.status, "value") else data.status
        task.updated_at = datetime.now(UTC)
        session.add(task)

    if auto_commit:
        session.commit()
        session.refresh(status_update)
    else:
        session.flush()
    return status_update
