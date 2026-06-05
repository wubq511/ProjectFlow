"""File upload endpoint — accepts multipart/form-data and saves to disk."""

import logging
import os
import uuid

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

logger = logging.getLogger(__name__)

UPLOAD_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "uploads"))
os.makedirs(UPLOAD_DIR, exist_ok=True)

router = APIRouter(tags=["uploads"])


class UploadResponse(BaseModel):
    file_id: str
    original_name: str
    saved_path: str


@router.post("/uploads", response_model=UploadResponse)
async def api_upload_file(file: UploadFile):
    """Upload a file. Returns the server-side path for storage as a resource reference."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")

    # 生成唯一文件名，保留原始扩展名
    ext = os.path.splitext(file.filename)[1] or ""
    unique_name = f"{uuid.uuid4().hex}{ext}"
    saved_path = os.path.join(UPLOAD_DIR, unique_name)

    try:
        content = await file.read()
        with open(saved_path, "wb") as f:
            f.write(content)
    except Exception as exc:
        logger.exception("Failed to save uploaded file")
        raise HTTPException(status_code=500, detail=f"保存文件失败: {exc}") from exc

    logger.info("File uploaded: %s -> %s (%d bytes)", file.filename, saved_path, len(content))
    return UploadResponse(
        file_id=unique_name,
        original_name=file.filename,
        saved_path=saved_path,
    )
