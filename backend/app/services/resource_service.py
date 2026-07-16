from sqlmodel import Session, select

from app.models.resource import ProjectResource
from app.schemas.resource import ResourceCreate


def create_resource(session: Session, data: ResourceCreate) -> ProjectResource:
    title = data.title or data.file_name or data.url or "未命名资源"
    resource = ProjectResource(
        project_id=data.project_id,
        type=data.type,
        title=title,
        content_text=data.content_text,
        file_name=data.file_name,
        url=data.url,
    )
    session.add(resource)
    session.commit()
    session.refresh(resource)
    return resource


def delete_resource(session: Session, resource_id: str) -> None:
    import os
    from app.core.db_utils import require_row
    resource = require_row(session, ProjectResource, resource_id, "resource")

    # 如果是上传的文件引用，同步删除磁盘上的文件
    if resource.type == "file_stub" and resource.file_name:
        from app.core.config import settings
        upload_dir = settings.resolved_upload_dir
        file_path = resource.file_name
        # 只删除 uploads 目录内的文件，防止误删其他路径
        if os.path.isfile(file_path) and os.path.normpath(file_path).startswith(upload_dir):
            try:
                os.remove(file_path)
            except OSError:
                pass  # 文件可能已被外部删除，忽略

    session.delete(resource)
    session.commit()


def list_resources_by_project(session: Session, project_id: str) -> list[ProjectResource]:
    return list(
        session.exec(
            select(ProjectResource).where(ProjectResource.project_id == project_id)
        ).all()
    )
