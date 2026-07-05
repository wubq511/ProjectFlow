"""T41 Internal Agent Tools API Routes.

Provides the unified internal tool endpoint:
- POST /internal/agent-tools/{tool_name} — execute a ProjectFlow tool

Read-only tools dispatch to existing read services and return
side_effect_status=no_side_effect. Draft-only proposal tools create pending
AgentProposal rows and return side_effect_status=proposal_persisted without
committing Primary Project State.

These endpoints use service-to-service authentication (not browser cookies).
Service-token verification is a repo-wide hardening item tracked separately;
the existing /internal/agent-runs/* routes share the same gap.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.runtime import ProjectFlowToolResult, ToolExecutionRequest
from app.services.agent_tools_service import ToolNotFoundError, execute_agent_tool

router = APIRouter(prefix="/internal/agent-tools", tags=["agent-tools"])

# Internal endpoint names currently exposed through this dispatcher.
AGENT_TOOLS = {
    "workspace-state",
    "conversation",
    "pending-proposals",
    "timeline-slice",
    "replan-proposal",
}


@router.post("/{tool_name}", response_model=ProjectFlowToolResult)
def execute_tool(
    tool_name: str,
    request: ToolExecutionRequest,
    session: Session = Depends(get_session),
) -> ProjectFlowToolResult:
    """Execute a ProjectFlow tool via the unified internal contract.

    The sidecar submits one envelope (run_id, tool_call_id, arguments, trace, ...);
    FastAPI dispatches to the tool handler and returns a ProjectFlowToolResult.
    """
    # Dispatch by the path endpoint name. The envelope may carry the model-facing
    # manifest name (for example, generate_replan_proposal) for traceability.
    if tool_name not in AGENT_TOOLS:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_name}")

    try:
        return execute_agent_tool(session, request, dispatch_tool_name=tool_name)
    except ToolNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
