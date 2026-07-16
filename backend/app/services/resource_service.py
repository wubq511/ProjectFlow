import logging
from sqlmodel import Session, select

from app.models.resource import ProjectResource
from app.schemas.resource import ResourceCreate

logger = logging.getLogger(__name__)


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


def delete_uploaded_file_if_safe(file_name: str) -> None:
    """Delete an upload basename without accepting arbitrary path semantics."""
    import os
    from app.core.config import settings
    upload_dir = settings.resolved_upload_dir
    if (
        not file_name
        or file_name in {".", ".."}
        or os.path.isabs(file_name)
        or os.path.basename(file_name) != file_name
        or os.sep in file_name
        or (os.altsep and os.altsep in file_name)
    ):
        raise PermissionError("安全审计拦截: 上传文件名必须是不含路径的 basename")

    file_path = os.path.join(upload_dir, file_name)

    if not is_safe_path(file_path, upload_dir):
        logger.error("Path traversal attempt detected during deletion: %s outside %s", file_path, upload_dir)
        raise PermissionError(f"安全审计拦截: 目标路径 {file_path} 超出合法目录限制 {upload_dir}")

    if os.path.isfile(file_path):
        try:
            os.remove(file_path)
        except OSError as e:
            logger.error("Failed to delete physical file %s: %s", file_path, str(e))
            raise IOError(f"物理删除失败: {file_path} - {e}") from e


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
