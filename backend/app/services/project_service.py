from datetime import UTC, datetime

from sqlmodel import Session, select

from app.models.project import Project
from app.schemas.project import ProjectCreate, ProjectUpdate


def create_project(session: Session, data: ProjectCreate) -> Project:
    project = Project(
        workspace_id=data.workspace_id,
        name=data.name,
        idea=data.idea,
        deadline=data.deadline,
        deliverables=data.deliverables,
        created_by=data.created_by,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


def get_project(session: Session, project_id: str) -> Project | None:
    return session.get(Project, project_id)


def list_projects_by_workspace(session: Session, workspace_id: str) -> list[Project]:
    return list(
        session.exec(select(Project).where(Project.workspace_id == workspace_id)).all()
    )


def update_project(session: Session, project_id: str, data: ProjectUpdate) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"Project {project_id} not found")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(project, key, value)
    project.updated_at = datetime.now(UTC)

    session.add(project)
    session.commit()
    session.refresh(project)
    return project
