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


def is_safe_path(file_path: str, base_dir: str) -> bool:
    import os
    abs_path = os.path.realpath(file_path)
    abs_base = os.path.realpath(base_dir)
    return abs_path == abs_base or abs_path.startswith(abs_base + os.sep)


def delete_uploaded_file_if_safe(file_path: str) -> None:
    """Safely delete a physical file only if it is contained within settings.resolved_upload_dir."""
    import os
    from app.core.config import settings
    upload_dir = settings.resolved_upload_dir
    if os.path.isfile(file_path) and is_safe_path(file_path, upload_dir):
        try:
            os.remove(file_path)
        except OSError:
            pass


def save_uploaded_file(file) -> str:
    """Save an uploaded file using dynamic upload directory, returning the unique file ID."""
    import os
    import shutil
    import uuid
    from app.core.config import settings

    upload_dir = settings.resolved_upload_dir
    os.makedirs(upload_dir, exist_ok=True)

    ext = os.path.splitext(file.filename)[1].lower()
    unique_name = f"{uuid.uuid4().hex}{ext}"
    saved_path = os.path.join(upload_dir, unique_name)

    with open(saved_path, "wb") as f:
        shutil.copyfileobj(file.file, f, length=64 * 1024)

    return unique_name


def delete_resource(session: Session, resource_id: str) -> None:
    from app.core.db_utils import require_row
    resource = require_row(session, ProjectResource, resource_id, "resource")

    # 如果是上传的文件引用，同步删除磁盘上的文件
    if resource.type == "file_stub" and resource.file_name:
        delete_uploaded_file_if_safe(resource.file_name)

    session.delete(resource)
    session.commit()


def list_resources_by_project(session: Session, project_id: str) -> list[ProjectResource]:
    return list(
        session.exec(
            select(ProjectResource).where(ProjectResource.project_id == project_id)
        ).all()
    )
