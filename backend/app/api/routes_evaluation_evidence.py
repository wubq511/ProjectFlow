"""T46-2 Evaluation Evidence Snapshot API Routes.

Provides the single authenticated, evaluation-only, read-only evidence seam:
- GET /internal/evaluation/evidence — build a normalized snapshot for graders

This endpoint is NOT a second behavior entry point. It only reads state that
the public HTTP/SSE seam has already produced. It cannot mutate state, create
runs, confirm proposals, or alter ProjectMemory.

Authentication requires BOTH:
1. Sidecar service token (Authorization: Bearer ...) — same as /internal/agent-runs/*
2. Evaluator-owned instance identity (nonce + instance ID + ownership marker +
   path containment) — same as the destructive seed endpoint

The route handler is intentionally thin: it validates inputs, delegates to the
read-only service, and returns the schema. All business logic lives in the
service layer.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session

from app.core.database import get_session
from app.core.security import require_evaluation_evidence_access
from app.schemas.evaluation_evidence import EvaluationEvidenceSnapshot
from app.services.evaluation_evidence_service import build_evidence_snapshot

router = APIRouter(
    prefix="/internal/evaluation",
    tags=["evaluation-evidence"],
    dependencies=[Depends(require_evaluation_evidence_access)],
)


@router.get("/evidence", response_model=EvaluationEvidenceSnapshot)
def read_evaluation_evidence(
    workspace_id: str = Query(..., description="目标工作区 ID"),
    viewer_user_id: str = Query(..., description="执行查看的 viewer 用户 ID"),
    project_id: str | None = Query(None, description="目标项目 ID；省略则取工作区内最新项目"),
    conversation_id: str | None = Query(None, description="关联会话 ID（仅用于快照标记）"),
    run_id: str | None = Query(
        None,
        description="关联 AgentRunV2 ID；提供后才会返回 trajectory/side_effect/metric/context_receipt facts",
    ),
    session: Session = Depends(get_session),
) -> EvaluationEvidenceSnapshot:
    """Build a normalized, viewer-scoped evidence snapshot for graders.

    Read-only: this endpoint never mutates database state.
    """
    try:
        return build_evidence_snapshot(
            session,
            workspace_id=workspace_id,
            viewer_user_id=viewer_user_id,
            project_id=project_id,
            conversation_id=conversation_id,
            run_id=run_id,
        )
    except ValueError as exc:
        msg = str(exc)
        if "不存在" in msg or "不是" in msg or "成员" in msg:
            raise HTTPException(status_code=404, detail="工作区或项目不存在") from exc
        raise HTTPException(status_code=400, detail=msg) from exc