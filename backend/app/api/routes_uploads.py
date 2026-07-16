import logging
import os

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel
from app.services.resource_service import save_uploaded_file

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".txt", ".md", ".csv", ".xlsx", ".pptx", ".zip"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB

router = APIRouter(tags=["uploads"])


class UploadResponse(BaseModel):
    file_id: str
    original_name: str


@router.post("/uploads", response_model=UploadResponse)
async def api_upload_file(file: UploadFile):
    """上传文件。返回服务器端文件 ID，用于作为资源引用存储。"""
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")

    # Validate extension against whitelist
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的文件类型: {ext}")

    # Validate file size
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="文件大小超过 10MB 限制")

    # Reset file position after size check
    await file.seek(0)

    try:
        file_id = save_uploaded_file(file)
    except Exception:
        logger.exception("Failed to save uploaded file")
        raise HTTPException(status_code=500, detail="保存文件失败，请稍后重试") from None

    logger.info("File uploaded: %s -> %s", file.filename, file_id)
    return UploadResponse(
        file_id=file_id,
        original_name=file.filename,
    )
