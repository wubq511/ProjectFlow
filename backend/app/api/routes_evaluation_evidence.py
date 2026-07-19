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
from app.services.evaluation_evidence_service import (
    EvaluationEvidenceNotFoundError,
    EvaluationEvidenceRequestError,
    build_evidence_snapshot,
)

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
    conversation_id: str | None = Query(None, description="viewer 可见且与 run 匹配的关联会话 ID"),
    run_id: str | None = Query(
        None,
        description="关联 AgentRunV2 ID；提供后才会返回 trajectory/side_effect/metric/context_receipt facts",
    ),
    hidden_token_probe: list[str] = Query(
        default=[],
        description="隐藏字段探针，格式为 length:sha256；只返回命中布尔值",
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
            hidden_token_probes=hidden_token_probe,
        )
    except EvaluationEvidenceNotFoundError as exc:
        # Keep scope failures indistinguishable from missing resources so this
        # narrow evidence seam cannot be used to enumerate cross-project data.
        raise HTTPException(status_code=404, detail="评测证据不存在") from exc
    except EvaluationEvidenceRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
