"""Display resolver: structural ID → user-visible display name/title.

All user-visible ProjectMemory text must go through this module.
Falls back to safe Chinese placeholders when the entity is not found.
"""

from sqlmodel import Session

from app.models import User, Project, Task, Stage


def resolve_display_name(session: Session, user_id: str) -> str:
    """user_id → User.display_name 或 '该成员'"""
    user = session.get(User, user_id)
    if user is not None:
        return user.display_name
    return "该成员"


def resolve_project_name(session: Session, project_id: str) -> str:
    """project_id → Project.name 或 '该项目'"""
    project = session.get(Project, project_id)
    if project is not None:
        return project.name
    return "该项目"


def resolve_task_title(session: Session, task_id: str) -> str:
    """task_id → Task.title 或 '该任务'"""
    task = session.get(Task, task_id)
    if task is not None:
        return task.title
    return "该任务"


def resolve_stage_title(session: Session, stage_id: str) -> str:
    """stage_id → Stage.name 或 '该阶段'"""
    stage = session.get(Stage, stage_id)
    if stage is not None:
        return stage.name
    return "该阶段"
