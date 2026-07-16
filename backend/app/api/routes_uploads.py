"""File upload endpoint — accepts multipart/form-data and saves to disk."""

import logging
import os
import shutil
import uuid

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from app.core.config import settings

def get_upload_dir() -> str:
    d = settings.resolved_upload_dir
    os.makedirs(d, exist_ok=True)
    return d

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".txt", ".md", ".csv", ".xlsx", ".pptx", ".zip"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB

router = APIRouter(tags=["uploads"])


class UploadResponse(BaseModel):
    file_id: str
    original_name: str


@router.post("/uploads", response_model=UploadResponse)
async def api_upload_file(file: UploadFile):
    """Upload a file. Returns the server-side file ID for storage as a resource reference."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")

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

    # Generate unique filename, preserve original extension
    unique_name = f"{uuid.uuid4().hex}{ext}"
    saved_path = os.path.join(get_upload_dir(), unique_name)

    try:
        with open(saved_path, "wb") as f:
            shutil.copyfileobj(file.file, f, length=64 * 1024)
    except Exception:
        logger.exception("Failed to save uploaded file")
        raise HTTPException(status_code=500, detail="保存文件失败，请稍后重试") from None

    logger.info("File uploaded: %s -> %s", file.filename, unique_name)
    return UploadResponse(
        file_id=unique_name,
        original_name=file.filename,
    )
