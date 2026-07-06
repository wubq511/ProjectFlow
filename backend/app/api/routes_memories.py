"""API routes for ProjectMemory read surfaces.

V1 exposes:
- GET /projects/{project_id}/memories?viewer_user_id=...  (JSON list)
- GET /projects/{project_id}/memories.md?viewer_user_id=...  (Markdown export)

Both require explicit viewer_user_id. Missing/invalid → 400.
Viewer outside workspace → 404.
Cache-Control: no-store on all responses.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.project_memory import ProjectMemoryRead
from app.services.memory_service import (
    export_memories_markdown,
    get_visible_memories,
    validate_viewer,
)

router = APIRouter(tags=["project-memories"])

NO_STORE_HEADERS = {"Cache-Control": "no-store"}


def _memory_to_read(memory) -> ProjectMemoryRead:
    return ProjectMemoryRead(
        id=memory.id,
        project_id=memory.project_id,
        workspace_id=memory.workspace_id,
        memory_type=memory.memory_type,
        scope=memory.scope,
        content=memory.content,
        rationale=memory.rationale,
        source_type=memory.source_type,
        source_id=memory.source_id,
        status=memory.status,
        visibility=memory.visibility,
        valid_until=memory.valid_until,
        related_stage_id=memory.related_stage_id,
        related_task_id=memory.related_task_id,
        related_risk_id=memory.related_risk_id,
        created_at=memory.created_at,
        updated_at=memory.updated_at,
    )


def _validate_and_get_project(session: Session, project_id: str, viewer_user_id: str | None):
    """Validate viewer_user_id and return project. Raises HTTPException on error.

    - Missing/empty viewer_user_id → 400
    - User not found → 400
    - Project not found → 404
    - Viewer not in workspace → 404
    """
    if not viewer_user_id or not viewer_user_id.strip():
        raise HTTPException(status_code=400, detail="viewer_user_id 不能为空")

    try:
        project, _ = validate_viewer(
            session, project_id=project_id, viewer_user_id=viewer_user_id
        )
    except ValueError as exc:
        msg = str(exc)
        # "不是...成员" → 404 (viewer outside workspace)
        # "项目不存在" → 404
        if "不是" in msg and "成员" in msg:
            raise HTTPException(status_code=404, detail="项目不存在") from exc
        if "项目不存在" in msg:
            raise HTTPException(status_code=404, detail="项目不存在") from exc
        # Other validation errors → 400
        raise HTTPException(status_code=400, detail=msg) from exc

    return project


@router.get("/projects/{project_id}/memories")
def api_list_memories(
    project_id: str,
    viewer_user_id: str | None = Query(None, description="Viewer user ID"),
    session: Session = Depends(get_session),
):
    """只读记忆列表（JSON）。需要 viewer_user_id。"""
    _validate_and_get_project(session, project_id, viewer_user_id)

    memories = get_visible_memories(
        session, project_id=project_id, viewer_user_id=viewer_user_id
    )
    result = [_memory_to_read(m).model_dump() for m in memories]

    import json
    return Response(
        content=json.dumps(result, ensure_ascii=False, default=str),
        media_type="application/json",
        headers=NO_STORE_HEADERS,
    )


@router.get("/projects/{project_id}/memories.md")
def api_export_memories_markdown(
    project_id: str,
    viewer_user_id: str | None = Query(None, description="Viewer user ID"),
    session: Session = Depends(get_session),
):
    """只读 Markdown 导出。需要 viewer_user_id。"""
    project = _validate_and_get_project(session, project_id, viewer_user_id)

    memories = get_visible_memories(
        session, project_id=project_id, viewer_user_id=viewer_user_id
    )
    markdown = export_memories_markdown(memories, project_name=project.name)

    return PlainTextResponse(
        content=markdown,
        media_type="text/markdown; charset=utf-8",
        headers=NO_STORE_HEADERS,
    )
