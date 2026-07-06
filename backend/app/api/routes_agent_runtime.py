"""T41 Agent Runtime Internal API Routes.

Provides internal endpoints for sidecar communication:
- POST /internal/agent-runs/{run_id}/events:append — atomic event/state/tool persistence
- POST /internal/agent-runs — create a new run
- GET /internal/agent-runs/{run_id} — get run status
- POST /internal/agent-runs/{run_id}/cancel — cancel a run

These endpoints use service-to-service authentication (not browser cookies).
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.core.security import require_internal_service_access
from app.schemas.runtime import (
    AppendRequest,
    AppendResponse,
    RuntimeEventRead,
    RunCancelRequest,
    RunCancelResponse,
    RunStartRequest,
    RunStartResponse,
    RunStatusResponse,
)
from app.services.agent_runtime_service import get_agent_runtime_service

router = APIRouter(
    prefix="/internal/agent-runs",
    tags=["agent-runtime"],
    dependencies=[Depends(require_internal_service_access)],
)


@router.post("", response_model=RunStartResponse)
def start_agent_run(
    request: RunStartRequest,
    session: Session = Depends(get_session),
) -> RunStartResponse:
    """Create a new agent run.

    Called by FastAPI when a user initiates an agent conversation.
    Creates the run record and returns the run_id for subsequent calls.
    """
    service = get_agent_runtime_service(session)
    try:
        return service.start_run(request)
    except ValueError as exc:
        msg = str(exc)
        if "不是" in msg and "成员" in msg:
            raise HTTPException(status_code=404, detail="项目不存在") from exc
        if "项目不存在" in msg:
            raise HTTPException(status_code=404, detail="项目不存在") from exc
        raise HTTPException(status_code=400, detail=msg) from exc


@router.get("/{run_id}", response_model=RunStatusResponse)
def get_agent_run_status(
    run_id: str,
    session: Session = Depends(get_session),
) -> RunStatusResponse:
    """Get current status of an agent run.

    Returns run lifecycle state, current turn/step, and event sequence.
    """
    service = get_agent_runtime_service(session)
    result = service.get_run_status(run_id)
    if not result:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return result


@router.get("/{run_id}/events", response_model=list[RuntimeEventRead])
def list_agent_run_events(
    run_id: str,
    session: Session = Depends(get_session),
) -> list[RuntimeEventRead]:
    """List persisted runtime events for a run in event_seq order."""
    service = get_agent_runtime_service(session)
    result = service.list_run_events(run_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return result


@router.post("/{run_id}/events:append", response_model=AppendResponse)
def append_agent_run_events(
    run_id: str,
    request: AppendRequest,
    session: Session = Depends(get_session),
) -> AppendResponse:
    """Append events and state patches to a run atomically.

    This is the convergence contract for runtime persistence:
    - One request carries state_patch, events, and tool_results
    - FastAPI assigns event_seq monotonically per run_id
    - All writes happen in a single transaction
    - Idempotency key prevents duplicate processing

    Called by sidecar during tool execution and state transitions.
    """
    service = get_agent_runtime_service(session)
    try:
        return service.append_events(run_id, request)
    except ValueError as e:
        # 非法状态转换返回 400，其他 ValueError（如 run not found）返回 404
        if "非法状态转换" in str(e):
            raise HTTPException(status_code=400, detail=str(e))
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{run_id}/cancel", response_model=RunCancelResponse)
def cancel_agent_run(
    run_id: str,
    request: RunCancelRequest | None = None,
    session: Session = Depends(get_session),
) -> RunCancelResponse:
    """Cancel a running agent run.

    Transitions run to cancelling state.
    Sidecar should detect this and stop execution gracefully.
    """
    service = get_agent_runtime_service(session)

    # Get current run
    status_response = service.get_run_status(run_id)
    if not status_response:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Apply cancel state patch
    from app.models.enums import AgentRunStatus
    from app.schemas.runtime import AppendRequest as AppendReq

    cancel_request = AppendReq(
        idempotency_key=f"{run_id}:cancel:v1",
        state_patch={"status": AgentRunStatus.cancelling.value},
    )

    try:
        service.append_events(run_id, cancel_request)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return RunCancelResponse(
        run_id=run_id,
        status=AgentRunStatus.cancelling,
        cancelled=True,
    )
