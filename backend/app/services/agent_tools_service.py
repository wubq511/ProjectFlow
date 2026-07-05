"""T41 Internal Agent Tools Service.

Dispatches POST /internal/agent-tools/{tool_name} to ProjectFlow tool handlers
and wraps results in the unified ProjectFlowToolResult envelope.

Read-only tools never mutate Primary Project State; they return
side_effect_status=no_side_effect. Proposal tools create reviewable draft
records and return side_effect_status=proposal_persisted after FastAPI persists
the AgentProposal.
"""

from typing import Any

from sqlmodel import Session, select

from app.models import AgentEvent, AgentProposal
from app.models.enums import SideEffectStatus, ToolResultStatus
from app.schemas.agent_proposal import AgentProposalRead
from app.schemas.agent_conversation import AgentConversationRead
from app.schemas.runtime import ProjectFlowToolResult, ToolError, ToolExecutionRequest, ToolLinks
from app.schemas.workspace_state import WorkspaceStateResponse
from app.services.agent_conversation_service import read_project_conversation
from app.services.agent_flow_service import run_agent_flow
from app.services.agent_proposal_service import list_proposals_by_project, to_proposal_read
from app.services.timeline_service import event_to_read, list_timeline_by_project
from app.services.workspace_state_service import get_workspace_state


class ToolNotFoundError(ValueError):
    """Raised when the requested tool_name is not registered."""


def _success(data: Any, observation: str) -> ProjectFlowToolResult:
    return ProjectFlowToolResult(
        status=ToolResultStatus.success,
        data=data if isinstance(data, dict) else {"value": data},
        side_effect_status=SideEffectStatus.no_side_effect,
        observation=observation,
    )


def _failed(code: str, message: str, *, side_effect_status: SideEffectStatus) -> ProjectFlowToolResult:
    return ProjectFlowToolResult(
        status=ToolResultStatus.failed,
        error=ToolError(code=code, reason=message, message=message),
        side_effect_status=side_effect_status,
        observation=message,
    )


def _serialize(value: Any) -> dict[str, Any]:
    """Normalize a pydantic model / list of models into a JSON-safe dict."""
    if isinstance(value, list):
        return {"items": [_item_to_dict(v) for v in value]}
    return _item_to_dict(value)


def _item_to_dict(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return value
    return {"value": value}


def execute_agent_tool(
    session: Session,
    request: ToolExecutionRequest,
    *,
    dispatch_tool_name: str | None = None,
) -> ProjectFlowToolResult:
    """Dispatch a ProjectFlow tool call and return a unified ProjectFlowToolResult."""
    tool_name = dispatch_tool_name or request.tool_name
    args = request.arguments or {}
    workspace_id = args.get("workspace_id") or request.workspace_id
    project_id = args.get("project_id") or request.project_id

    if tool_name == "workspace-state":
        state = get_workspace_state(session, workspace_id, project_id=args.get("project_id"))
        if state is None:
            return ProjectFlowToolResult(
                status=ToolResultStatus.failed,
                side_effect_status=SideEffectStatus.no_side_effect,
                observation=f"Workspace {workspace_id} not found",
            )
        return _success(_serialize(state), "workspace_state")

    if tool_name == "conversation":
        try:
            conversation = read_project_conversation(session, project_id)
        except ValueError as exc:
            return ProjectFlowToolResult(
                status=ToolResultStatus.failed,
                side_effect_status=SideEffectStatus.no_side_effect,
                observation=str(exc),
            )
        return _success(_serialize(conversation), "agent_conversation")

    if tool_name == "pending-proposals":
        proposals = list_proposals_by_project(session, project_id, status="pending")
        data = {"items": [to_proposal_read(p).model_dump(mode="json") for p in proposals]}
        return _success(data, f"{len(proposals)} pending proposals")

    if tool_name == "timeline-slice":
        limit = int(args.get("limit", 20))
        since = args.get("since")
        event_types = args.get("event_types")
        if isinstance(event_types, list):
            event_types = ",".join(str(t) for t in event_types)
        events = list_timeline_by_project(
            session,
            project_id,
            limit=limit,
            since=since if isinstance(since, str) else None,
            event_types=event_types if isinstance(event_types, str) else None,
        )
        # Use the same AgentEventRead shape as the public timeline route
        data = {"items": [event_to_read(e).model_dump(mode="json") for e in events]}
        return _success(data, f"{len(events)} timeline events")

    if tool_name == "replan-proposal":
        cached_proposal = _find_replan_proposal_for_idempotency_key(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            idempotency_key=request.idempotency_key,
        )
        if cached_proposal is not None:
            return _replan_proposal_result(
                proposal_id=cached_proposal.id,
                output=_cached_replan_tool_data(cached_proposal),
                request=request,
                observation="已复用同一次工具调用生成的计划调整草案。",
            )

        try:
            flow_result = run_agent_flow(
                session,
                workspace_id,
                lambda coordinator, state, instruction: coordinator.replan(
                    state,
                    user_instruction=instruction,
                ),
                project_id=project_id,
                user_instruction=args.get("user_instruction") if isinstance(args.get("user_instruction"), str) else None,
            )
        except ValueError as exc:
            return _failed(
                "REPLAN_PROPOSAL_FAILED",
                str(exc),
                side_effect_status=SideEffectStatus.no_side_effect,
            )
        if flow_result.proposal_id:
            _tag_proposal_event_with_idempotency_key(
                session,
                proposal_id=flow_result.proposal_id,
                request=request,
            )
        return _replan_proposal_result(
            proposal_id=flow_result.proposal_id,
            output=flow_result.model_dump(mode="json"),
            request=request,
            created_ids=flow_result.created_ids,
            observation=(
                "已生成待确认的计划调整草案。"
                if flow_result.proposal_id
                else "未生成计划调整草案。"
            ),
        )

    raise ToolNotFoundError(f"Unknown agent tool: {tool_name}")


def execute_read_only_tool(session: Session, request: ToolExecutionRequest) -> ProjectFlowToolResult:
    """Backward-compatible wrapper for existing read-only tool callers."""
    return execute_agent_tool(session, request)


def _replan_proposal_result(
    *,
    proposal_id: str | None,
    output: dict[str, Any],
    request: ToolExecutionRequest,
    observation: str,
    created_ids: list[str] | None = None,
) -> ProjectFlowToolResult:
    return ProjectFlowToolResult(
        status=ToolResultStatus.success,
        data=output,
        side_effect_status=(
            SideEffectStatus.proposal_persisted
            if proposal_id
            else SideEffectStatus.no_side_effect
        ),
        idempotency_key=request.idempotency_key,
        links=ToolLinks(
            proposal_id=proposal_id,
            created_ids=created_ids or [],
        ),
        observation=observation,
    )


def _find_replan_proposal_for_idempotency_key(
    session: Session,
    *,
    workspace_id: str,
    project_id: str,
    idempotency_key: str,
) -> AgentProposal | None:
    proposals = session.exec(
        select(AgentProposal)
        .where(
            AgentProposal.workspace_id == workspace_id,
            AgentProposal.project_id == project_id,
            AgentProposal.proposal_type == "replan",
        )
        .order_by(AgentProposal.created_at.desc())
    ).all()
    for proposal in proposals:
        event = session.get(AgentEvent, proposal.agent_event_id)
        if event is None:
            continue
        snapshot = event.get_input_snapshot()
        if isinstance(snapshot, dict) and snapshot.get("tool_idempotency_key") == idempotency_key:
            return proposal
    return None


def _tag_proposal_event_with_idempotency_key(
    session: Session,
    *,
    proposal_id: str,
    request: ToolExecutionRequest,
) -> None:
    proposal = session.get(AgentProposal, proposal_id)
    if proposal is None:
        return
    event = session.get(AgentEvent, proposal.agent_event_id)
    if event is None:
        return
    snapshot = event.get_input_snapshot()
    if not isinstance(snapshot, dict):
        snapshot = {"value": snapshot}
    snapshot["tool_idempotency_key"] = request.idempotency_key
    snapshot["tool_call_id"] = request.tool_call_id
    snapshot["tool_name"] = request.tool_name
    event.set_input_snapshot(snapshot)
    session.add(event)
    session.commit()


def _proposal_payload(proposal: AgentProposal) -> dict[str, Any]:
    proposal_read = to_proposal_read(proposal)
    if isinstance(proposal_read.payload, dict):
        return proposal_read.payload
    return {"value": proposal_read.payload}


def _cached_replan_tool_data(proposal: AgentProposal) -> dict[str, Any]:
    return {
        "event_type": "replan",
        "status": "cached",
        "attempts": 0,
        "used_fallback": False,
        "output": _proposal_payload(proposal),
        "created_ids": [],
        "proposal_id": proposal.id,
    }


__all__ = [
    "execute_agent_tool",
    "execute_read_only_tool",
    "ToolNotFoundError",
    "WorkspaceStateResponse",
    "AgentConversationRead",
    "AgentProposalRead",
]
