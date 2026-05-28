from sqlmodel import Session, select

from app.models.resource import ProjectResource
from app.schemas.resource import ResourceCreate


def create_resource(session: Session, data: ResourceCreate) -> ProjectResource:
    resource = ProjectResource(
        project_id=data.project_id,
        type=data.type,
        title=data.title,
        content_text=data.content_text,
        file_name=data.file_name,
        url=data.url,
    )
    session.add(resource)
    session.commit()
    session.refresh(resource)
    return resource


def list_resources_by_project(session: Session, project_id: str) -> list[ProjectResource]:
    return list(
        session.exec(
            select(ProjectResource).where(ProjectResource.project_id == project_id)
        ).all()
    )
