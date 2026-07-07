"""T41 Internal Agent Tools Service.

Dispatches POST /internal/agent-tools/{tool_name} to ProjectFlow tool handlers
and wraps results in the unified ProjectFlowToolResult envelope.

Read-only tools never mutate Primary Project State; they return
side_effect_status=no_side_effect. Proposal tools create reviewable draft
records and return side_effect_status=proposal_persisted after FastAPI persists
the AgentProposal.
"""

from typing import Any

from pydantic import ValidationError
from sqlmodel import Session, select

from app.agent.coordinator import CoordinatorAgent
from app.agent.output_schemas import ActionCardProposal, CheckInAnalysisOutput, RiskAnalysisOutput
from app.models import ActionCard, AgentEvent, AgentProposal, AssignmentProposal, Stage, Task, User, WorkspaceMembership
from app.models.enums import (
    ActionCardStatus,
    AgentEventType,
    AgentProposalStatus,
    SideEffectStatus,
    ToolResultStatus,
)
from app.schemas.action_card import ActionCardCreate
from app.schemas.agent_proposal import AgentProposalRead
from app.schemas.agent_conversation import AgentConversationRead
from app.schemas.assignment import AssignmentProposalCreate, AssignmentProposalRead
from app.schemas.checkin import CheckInCycleCreate, CheckInCycleRead, CheckInResponseCreate, CheckInResponseRead
from app.schemas.risk import RiskCreate, RiskRead
from app.schemas.runtime import ProjectFlowToolResult, ToolError, ToolExecutionRequest, ToolLinks
from app.schemas.workspace_state import WorkspaceStateResponse
from app.services.action_card_service import create_action_card
from app.services.agent_conversation_service import read_project_conversation
from app.services.agent_flow_service import run_agent_flow
from app.services.agent_proposal_service import list_proposals_by_project, to_proposal_read
from app.services.assignment_service import create_assignment_proposal
from app.services.checkin_service import create_checkin_cycle, create_checkin_response
from app.services.risk_service import create_risk
from app.services.timeline_service import event_to_read, list_timeline_by_project
from app.services.workspace_state_service import get_workspace_state


class ToolNotFoundError(ValueError):
    """Raised when the requested tool_name is not registered."""


# Read-only tools currently exposed through this dispatcher.
READ_ONLY_TOOLS = {
    "workspace-state",
    "conversation",
    "pending-proposals",
    "timeline-slice",
}


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
    # workspace_id and project_id come from the request envelope (set by sidecar
    # from run context), never from LLM-generated arguments.
    workspace_id = request.workspace_id
    project_id = request.project_id

    if tool_name == "workspace-state":
        state = get_workspace_state(session, workspace_id, project_id=project_id)
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

    if tool_name == "stage-plan-proposal":
        cached_proposal = _find_proposal_for_idempotency_key(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            proposal_type="plan",
            idempotency_key=request.idempotency_key,
        )
        if cached_proposal is not None:
            return _proposal_tool_result(
                proposal_id=cached_proposal.id,
                agent_event_id=cached_proposal.agent_event_id,
                output=_cached_proposal_tool_data(cached_proposal, event_type="plan"),
                request=request,
                observation="已复用同一次工具调用生成的阶段计划草案。",
            )

        try:
            flow_result = run_agent_flow(
                session,
                workspace_id,
                lambda coordinator, state, instruction: coordinator.generate_stage_plan(
                    state,
                    user_instruction=instruction,
                ),
                project_id=project_id,
                user_instruction=args.get("user_instruction") if isinstance(args.get("user_instruction"), str) else None,
                auto_commit=False,
            )
        except ValueError as exc:
            return _failed(
                "STAGE_PLAN_PROPOSAL_FAILED",
                str(exc),
                side_effect_status=SideEffectStatus.no_side_effect,
            )
        if flow_result.proposal_id:
            _tag_proposal_event_with_idempotency_key(
                session,
                proposal_id=flow_result.proposal_id,
                request=request,
            )
            session.commit()
        return _proposal_tool_result(
            proposal_id=flow_result.proposal_id,
            agent_event_id=_proposal_agent_event_id(session, flow_result.proposal_id),
            output=flow_result.model_dump(mode="json"),
            request=request,
            created_ids=flow_result.created_ids,
            observation=(
                "已生成待确认的阶段计划草案。"
                if flow_result.proposal_id
                else "未生成阶段计划草案。"
            ),
        )

    if tool_name == "checkins-and-risks-analysis":
        cached_event = _find_cached_advisory_event(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            dispatch_tool_name=tool_name,
            idempotency_key=request.idempotency_key,
        )
        if cached_event is not None:
            return _cached_advisory_tool_result(cached_event)

        try:
            return _execute_checkins_and_risks_analysis(
                session,
                request=request,
                dispatch_tool_name=tool_name,
                workspace_id=workspace_id,
                project_id=project_id,
                user_instruction=args.get("user_instruction") if isinstance(args.get("user_instruction"), str) else None,
            )
        except ValueError as exc:
            return _failed(
                "CHECKINS_AND_RISKS_ANALYSIS_FAILED",
                str(exc),
                side_effect_status=SideEffectStatus.no_side_effect,
            )

    if tool_name == "replan-proposal":
        cached_proposal = _find_proposal_for_idempotency_key(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            proposal_type="replan",
            idempotency_key=request.idempotency_key,
        )
        if cached_proposal is not None:
            return _proposal_tool_result(
                proposal_id=cached_proposal.id,
                agent_event_id=cached_proposal.agent_event_id,
                output=_cached_proposal_tool_data(cached_proposal, event_type="replan"),
                request=request,
                observation="已复用同一次工具调用生成的计划调整草案。",
            )

        pending_proposal = _find_pending_replan_proposal(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        if pending_proposal is not None:
            return _blocked_pending_replan_result(pending_proposal, request)

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
                auto_commit=False,
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
            session.commit()
        return _proposal_tool_result(
            proposal_id=flow_result.proposal_id,
            agent_event_id=_proposal_agent_event_id(session, flow_result.proposal_id),
            output=flow_result.model_dump(mode="json"),
            request=request,
            created_ids=flow_result.created_ids,
            observation=(
                "已生成待确认的计划调整草案。"
                if flow_result.proposal_id
                else "未生成计划调整草案。"
            ),
        )

    if tool_name == "direction-card-proposal":
        cached_proposal = _find_proposal_for_idempotency_key(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            proposal_type="clarify",
            idempotency_key=request.idempotency_key,
        )
        if cached_proposal is not None:
            return _proposal_tool_result(
                proposal_id=cached_proposal.id,
                agent_event_id=cached_proposal.agent_event_id,
                output=_cached_proposal_tool_data(cached_proposal, event_type="clarify"),
                request=request,
                observation="已复用同一次工具调用生成的方向卡草案。",
            )

        try:
            flow_result = run_agent_flow(
                session,
                workspace_id,
                lambda coordinator, state, instruction: coordinator.generate_direction_card(
                    state,
                    user_instruction=instruction,
                ),
                project_id=project_id,
                user_instruction=args.get("user_instruction") if isinstance(args.get("user_instruction"), str) else None,
                auto_commit=False,
            )
        except ValueError as exc:
            return _failed(
                "DIRECTION_CARD_PROPOSAL_FAILED",
                str(exc),
                side_effect_status=SideEffectStatus.no_side_effect,
            )
        if flow_result.proposal_id:
            _tag_proposal_event_with_idempotency_key(
                session,
                proposal_id=flow_result.proposal_id,
                request=request,
            )
            session.commit()
        return _proposal_tool_result(
            proposal_id=flow_result.proposal_id,
            agent_event_id=_proposal_agent_event_id(session, flow_result.proposal_id),
            output=flow_result.model_dump(mode="json"),
            request=request,
            created_ids=flow_result.created_ids,
            observation=(
                "已生成待确认的方向卡草案。"
                if flow_result.proposal_id
                else "未生成方向卡草案。"
            ),
        )

    if tool_name == "task-breakdown-proposal":
        cached_proposal = _find_proposal_for_idempotency_key(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            proposal_type="breakdown",
            idempotency_key=request.idempotency_key,
        )
        if cached_proposal is not None:
            return _proposal_tool_result(
                proposal_id=cached_proposal.id,
                agent_event_id=cached_proposal.agent_event_id,
                output=_cached_proposal_tool_data(cached_proposal, event_type="breakdown"),
                request=request,
                observation="已复用同一次工具调用生成的任务拆解草案。",
            )

        try:
            flow_result = run_agent_flow(
                session,
                workspace_id,
                lambda coordinator, state, instruction: coordinator.generate_task_breakdown(
                    state,
                    user_instruction=instruction,
                ),
                project_id=project_id,
                user_instruction=args.get("user_instruction") if isinstance(args.get("user_instruction"), str) else None,
                auto_commit=False,
            )
        except ValueError as exc:
            return _failed(
                "TASK_BREAKDOWN_PROPOSAL_FAILED",
                str(exc),
                side_effect_status=SideEffectStatus.no_side_effect,
            )
        if flow_result.proposal_id:
            _tag_proposal_event_with_idempotency_key(
                session,
                proposal_id=flow_result.proposal_id,
                request=request,
            )
            session.commit()
        return _proposal_tool_result(
            proposal_id=flow_result.proposal_id,
            agent_event_id=_proposal_agent_event_id(session, flow_result.proposal_id),
            output=flow_result.model_dump(mode="json"),
            request=request,
            created_ids=flow_result.created_ids,
            observation=(
                "已生成待确认的任务拆解草案。"
                if flow_result.proposal_id
                else "未生成任务拆解草案。"
            ),
        )

    if tool_name == "assignment-recommendation":
        cached_event = _find_cached_assignment_event(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            dispatch_tool_name=tool_name,
            idempotency_key=request.idempotency_key,
        )
        if cached_event is not None:
            return _cached_assignment_tool_result(cached_event)
        return execute_assignment_recommendation(session, request)

    # ─── S11 tools ──────────────────────────────────────────────────────────
    if tool_name == "create-risk":
        return execute_create_risk(session, request)

    if tool_name == "create-checkin":
        return execute_create_checkin(session, request)

    raise ToolNotFoundError(f"Unknown agent tool: {tool_name}")


def execute_read_only_tool(session: Session, request: ToolExecutionRequest) -> ProjectFlowToolResult:
    """Backward-compatible wrapper for existing read-only tool callers."""
    return execute_agent_tool(session, request)


def _proposal_tool_result(
    *,
    proposal_id: str | None,
    agent_event_id: str | None,
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
            agent_event_id=agent_event_id,
            proposal_id=proposal_id,
            created_ids=created_ids or [],
        ),
        observation=observation,
    )


def _blocked_pending_replan_result(
    proposal: AgentProposal,
    request: ToolExecutionRequest,
) -> ProjectFlowToolResult:
    message = "项目已有待确认的计划调整草案，请先确认或拒绝现有草案后再生成新的重规划。"
    return ProjectFlowToolResult(
        status=ToolResultStatus.blocked,
        data={
            "existing_proposal": to_proposal_read(proposal).model_dump(mode="json"),
        },
        error=ToolError(
            code="PENDING_REPLAN_PROPOSAL_EXISTS",
            reason=message,
            message=message,
        ),
        side_effect_status=SideEffectStatus.no_side_effect,
        idempotency_key=request.idempotency_key,
        links=ToolLinks(proposal_id=proposal.id),
        observation=message,
    )


def _find_pending_replan_proposal(
    session: Session,
    *,
    workspace_id: str,
    project_id: str,
) -> AgentProposal | None:
    return session.exec(
        select(AgentProposal)
        .where(
            AgentProposal.workspace_id == workspace_id,
            AgentProposal.project_id == project_id,
            AgentProposal.proposal_type == "replan",
            AgentProposal.status == AgentProposalStatus.pending,
        )
        .order_by(AgentProposal.created_at.desc())
    ).first()


def _execute_checkins_and_risks_analysis(
    session: Session,
    *,
    request: ToolExecutionRequest,
    dispatch_tool_name: str,
    workspace_id: str,
    project_id: str,
    user_instruction: str | None,
) -> ProjectFlowToolResult:
    workspace_state = get_workspace_state(session, workspace_id, project_id=project_id)
    if workspace_state is None:
        return _failed(
            "WORKSPACE_NOT_FOUND",
            f"Workspace {workspace_id} not found",
            side_effect_status=SideEffectStatus.no_side_effect,
        )
    if workspace_state.project is None:
        return _failed(
            "PROJECT_NOT_FOUND",
            f"Project {project_id} not found in workspace {workspace_id}",
            side_effect_status=SideEffectStatus.no_side_effect,
        )
    action_cards_result = _parse_action_cards_argument(request.arguments or {})
    if isinstance(action_cards_result, ProjectFlowToolResult):
        return action_cards_result
    action_cards = action_cards_result

    coordinator = CoordinatorAgent(session=session)
    checkin_result = coordinator.analyze_checkin(
        workspace_state,
        user_instruction=user_instruction,
    )
    checkin_output = CheckInAnalysisOutput.model_validate(checkin_result.output.model_dump(mode="json"))
    checkin_event_id = _latest_agent_event_id(
        session,
        workspace_id=workspace_id,
        project_id=project_id,
        event_type=AgentEventType.checkin,
    )

    risk_result = coordinator.analyze_risks(
        workspace_state,
        user_instruction=user_instruction,
    )
    risk_output = RiskAnalysisOutput.model_validate(risk_result.output.model_dump(mode="json"))
    risk_event_id = _latest_agent_event_id(
        session,
        workspace_id=workspace_id,
        project_id=project_id,
        event_type=AgentEventType.risk,
    )

    created_ids = _dedupe_ids(
        [
            *_persist_advisory_risks(session, project_id, checkin_output.risks),
            *_persist_advisory_risks(session, project_id, risk_output.risks),
            *_persist_advisory_action_cards(session, project_id, action_cards),
        ]
    )
    related_event_ids = [event_id for event_id in [checkin_event_id, risk_event_id] if event_id]
    primary_event_id = checkin_event_id or risk_event_id
    replan_signal = _build_replan_signal(checkin_output, risk_output)
    data = {
        "event_type": "checkin_and_risk_analysis",
        "status": "success",
        "checkin_analysis": checkin_result.output.model_dump(mode="json"),
        "risk_analysis": risk_result.output.model_dump(mode="json"),
        "replan_signal": replan_signal,
        "created_ids": created_ids,
        "related_event_ids": related_event_ids,
    }
    observation = _build_checkin_risk_observation(created_ids, replan_signal)

    for event_id in related_event_ids:
        _tag_agent_event_with_tool_request(
            session,
            event_id=event_id,
            request=request,
            dispatch_tool_name=dispatch_tool_name,
        )
    if primary_event_id is not None:
        _store_advisory_tool_result(
            session,
            event_id=primary_event_id,
            result=_advisory_tool_result(
                data=data,
                request=request,
                agent_event_id=primary_event_id,
                created_ids=created_ids,
                observation=observation,
            ),
            related_event_ids=related_event_ids,
        )
    session.commit()
    return _advisory_tool_result(
        data=data,
        request=request,
        agent_event_id=primary_event_id,
        created_ids=created_ids,
        observation=observation,
    )


def _find_proposal_for_idempotency_key(
    session: Session,
    *,
    workspace_id: str,
    project_id: str,
    proposal_type: str,
    idempotency_key: str,
) -> AgentProposal | None:
    proposals = session.exec(
        select(AgentProposal)
        .where(
            AgentProposal.workspace_id == workspace_id,
            AgentProposal.project_id == project_id,
            AgentProposal.proposal_type == proposal_type,
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
    snapshot["tool_run_id"] = request.run_id
    snapshot["conversation_id"] = request.conversation_id
    snapshot["tool_call_id"] = request.tool_call_id
    snapshot["tool_name"] = request.tool_name
    event.set_input_snapshot(snapshot)
    session.add(event)
    session.flush()


def _advisory_tool_result(
    *,
    data: dict[str, Any],
    request: ToolExecutionRequest,
    agent_event_id: str | None,
    created_ids: list[str],
    observation: str,
) -> ProjectFlowToolResult:
    return ProjectFlowToolResult(
        status=ToolResultStatus.success,
        data=data,
        side_effect_status=(
            SideEffectStatus.advisory_record_persisted
            if created_ids
            else SideEffectStatus.no_side_effect
        ),
        idempotency_key=request.idempotency_key,
        links=ToolLinks(
            agent_event_id=agent_event_id,
            created_ids=created_ids,
        ),
        observation=observation,
    )


def _proposal_agent_event_id(session: Session, proposal_id: str | None) -> str | None:
    if proposal_id is None:
        return None
    proposal = session.get(AgentProposal, proposal_id)
    if proposal is None:
        return None
    return proposal.agent_event_id


def _proposal_payload(proposal: AgentProposal) -> dict[str, Any]:
    proposal_read = to_proposal_read(proposal)
    if isinstance(proposal_read.payload, dict):
        return proposal_read.payload
    return {"value": proposal_read.payload}


def _cached_proposal_tool_data(proposal: AgentProposal, *, event_type: str) -> dict[str, Any]:
    return {
        "event_type": event_type,
        "status": "cached",
        "attempts": 0,
        "used_fallback": False,
        "output": _proposal_payload(proposal),
        "created_ids": [],
        "proposal_id": proposal.id,
    }


def _find_cached_advisory_event(
    session: Session,
    *,
    workspace_id: str,
    project_id: str,
    dispatch_tool_name: str,
    idempotency_key: str,
) -> AgentEvent | None:
    events = session.exec(
        select(AgentEvent)
        .where(
            AgentEvent.workspace_id == workspace_id,
            AgentEvent.project_id == project_id,
        )
        .order_by(AgentEvent.created_at.desc())
    ).all()
    for event in events:
        input_snapshot = event.get_input_snapshot()
        if not isinstance(input_snapshot, dict):
            continue
        if input_snapshot.get("tool_idempotency_key") != idempotency_key:
            continue
        if input_snapshot.get("tool_dispatch_name") != dispatch_tool_name:
            continue
        output_snapshot = event.get_output_snapshot()
        if isinstance(output_snapshot, dict) and isinstance(output_snapshot.get("tool_result"), dict):
            return event
    return None


def _cached_advisory_tool_result(event: AgentEvent) -> ProjectFlowToolResult:
    output_snapshot = event.get_output_snapshot()
    if isinstance(output_snapshot, dict) and isinstance(output_snapshot.get("tool_result"), dict):
        return ProjectFlowToolResult.model_validate(output_snapshot["tool_result"])
    raise ValueError("Cached advisory tool result is missing from agent event output")


def _find_cached_assignment_event(
    session: Session,
    *,
    workspace_id: str,
    project_id: str,
    dispatch_tool_name: str,
    idempotency_key: str,
) -> AgentEvent | None:
    events = session.exec(
        select(AgentEvent)
        .where(
            AgentEvent.workspace_id == workspace_id,
            AgentEvent.project_id == project_id,
            AgentEvent.event_type == AgentEventType.assign,
        )
        .order_by(AgentEvent.created_at.desc())
    ).all()
    for event in events:
        input_snapshot = event.get_input_snapshot()
        if not isinstance(input_snapshot, dict):
            continue
        if input_snapshot.get("tool_idempotency_key") != idempotency_key:
            continue
        if input_snapshot.get("tool_dispatch_name") != dispatch_tool_name:
            continue
        output_snapshot = event.get_output_snapshot()
        if isinstance(output_snapshot, dict) and isinstance(output_snapshot.get("tool_result"), dict):
            return event
    return None


def _cached_assignment_tool_result(event: AgentEvent) -> ProjectFlowToolResult:
    output_snapshot = event.get_output_snapshot()
    if isinstance(output_snapshot, dict) and isinstance(output_snapshot.get("tool_result"), dict):
        return ProjectFlowToolResult.model_validate(output_snapshot["tool_result"])
    raise ValueError("Cached assignment tool result is missing from agent event output")


def _latest_agent_event_id(
    session: Session,
    *,
    workspace_id: str,
    project_id: str,
    event_type: AgentEventType,
) -> str | None:
    event = session.exec(
        select(AgentEvent)
        .where(
            AgentEvent.workspace_id == workspace_id,
            AgentEvent.project_id == project_id,
            AgentEvent.event_type == event_type,
        )
        .order_by(AgentEvent.created_at.desc())
    ).first()
    return event.id if event is not None else None


def _persist_advisory_risks(
    session: Session,
    project_id: str,
    risks: list[Any],
) -> list[str]:
    created_ids: list[str] = []
    for risk in risks:
        created = create_risk(
            session,
            RiskCreate(
                project_id=project_id,
                stage_id=risk.stage_id,
                task_id=risk.task_id,
                type=risk.type,
                severity=risk.severity,
                title=risk.title,
                description=risk.description,
                evidence=risk.evidence,
                recommendation=risk.recommendation,
                created_by_agent=True,
            ),
            auto_commit=False,
        )
        created_ids.append(created.id)
    return created_ids


def _parse_action_cards_argument(args: dict[str, Any]) -> list[ActionCardProposal] | ProjectFlowToolResult:
    raw_cards = args.get("action_cards", [])
    if raw_cards is None:
        return []
    if not isinstance(raw_cards, list):
        return ProjectFlowToolResult(
            status=ToolResultStatus.validation_error,
            error=ToolError(
                code="INVALID_ACTION_CARDS",
                reason="action_cards 必须是数组。",
                message="action_cards 必须是数组。",
            ),
            side_effect_status=SideEffectStatus.no_side_effect,
            observation="action_cards 必须是数组。",
        )
    try:
        return [ActionCardProposal.model_validate(card) for card in raw_cards]
    except ValidationError as exc:
        message = f"action_cards 格式不合法：{exc}"
        return ProjectFlowToolResult(
            status=ToolResultStatus.validation_error,
            error=ToolError(code="INVALID_ACTION_CARDS", reason=message, message=message),
            side_effect_status=SideEffectStatus.no_side_effect,
            observation=message,
        )


def _persist_advisory_action_cards(
    session: Session,
    project_id: str,
    action_cards: list[ActionCardProposal],
) -> list[str]:
    created_ids: list[str] = []
    for card in action_cards:
        existing = session.exec(
            select(ActionCard)
            .where(
                ActionCard.project_id == project_id,
                ActionCard.task_id == card.task_id,
                ActionCard.type == card.type,
                ActionCard.title == card.title,
                ActionCard.status == ActionCardStatus.active,
            )
            .order_by(ActionCard.created_at.desc())
        ).first()
        if existing is not None:
            created_ids.append(existing.id)
            continue
        created = create_action_card(
            session,
            ActionCardCreate(
                project_id=project_id,
                stage_id=card.stage_id,
                user_id=card.user_id,
                task_id=card.task_id,
                type=card.type,
                title=card.title,
                content=card.content or card.title,
                reason=card.reason,
                goal=card.goal,
                start_suggestion=card.start_suggestion,
                completion_standard=card.completion_standard,
                due_date=card.due_date,
                created_by_agent=True,
            ),
            auto_commit=False,
        )
        created_ids.append(created.id)
    return created_ids


def _build_replan_signal(
    checkin_output: CheckInAnalysisOutput,
    risk_output: RiskAnalysisOutput,
) -> dict[str, Any]:
    task_changes = [
        {
            "task_id": update.task_id,
            "user_id": update.user_id,
            "status": update.status.value if hasattr(update.status, "value") else update.status,
            "progress_note": update.progress_note,
            "blocker": update.blocker,
        }
        for update in checkin_output.task_updates
    ]
    requires_replan = bool(task_changes) or risk_output.requires_confirmation
    # 注意：risk_output.requires_confirmation 在新 runtime 中的语义是
    # "mitigation 涉及主事实变更需要 replan proposal 确认"，
    # 不再阻止 advisory Risk row 的创建（Risk row 本身是 advisory record，可直接创建）。
    reasons: list[str] = []
    if task_changes:
        reasons.append("签到分析产生了任务状态变化信号，必须进入待确认的重规划草案。")
    if risk_output.requires_confirmation:
        reasons.append("风险缓解建议涉及主事实变更，必须先进入待确认的重规划草案。")
    return {
        "requires_replan_proposal": requires_replan,
        "task_changes": task_changes,
        "reason": "；".join(reasons),
    }


def _build_checkin_risk_observation(created_ids: list[str], replan_signal: dict[str, Any]) -> str:
    created_count = len(created_ids)
    replan_needed = bool(replan_signal.get("requires_replan_proposal"))
    if created_count and replan_needed:
        return (
            f"已创建 {created_count} 条建议记录；"
            "检测到需要后续重规划草案确认的主事实变更信号。"
        )
    if created_count:
        return f"已创建 {created_count} 条建议记录，未直接修改主事实。"
    if replan_needed:
        return "未创建建议记录，但检测到需要后续重规划草案确认的主事实变更信号。"
    return "分析完成，未创建新的建议记录。"


def _tag_agent_event_with_tool_request(
    session: Session,
    *,
    event_id: str,
    request: ToolExecutionRequest,
    dispatch_tool_name: str,
) -> None:
    event = session.get(AgentEvent, event_id)
    if event is None:
        return
    snapshot = event.get_input_snapshot()
    if not isinstance(snapshot, dict):
        snapshot = {"value": snapshot}
    snapshot["tool_idempotency_key"] = request.idempotency_key
    snapshot["tool_run_id"] = request.run_id
    snapshot["conversation_id"] = request.conversation_id
    snapshot["tool_call_id"] = request.tool_call_id
    snapshot["tool_name"] = request.tool_name
    snapshot["tool_dispatch_name"] = dispatch_tool_name
    event.set_input_snapshot(snapshot)
    session.add(event)


def _store_advisory_tool_result(
    session: Session,
    *,
    event_id: str,
    result: ProjectFlowToolResult,
    related_event_ids: list[str],
) -> None:
    event = session.get(AgentEvent, event_id)
    if event is None:
        return
    snapshot = event.get_output_snapshot()
    if not isinstance(snapshot, dict):
        snapshot = {"value": snapshot}
    snapshot["tool_result"] = result.model_dump(mode="json")
    snapshot["related_event_ids"] = related_event_ids
    event.set_output_snapshot(snapshot)
    session.add(event)


def _dedupe_ids(ids: list[str]) -> list[str]:
    unique_ids: list[str] = []
    for value in ids:
        if value not in unique_ids:
            unique_ids.append(value)
    return unique_ids


# ─── Proposal tools (S8+) ─────────────────────────────────────────────────


def execute_assignment_recommendation(session: Session, request: ToolExecutionRequest) -> ProjectFlowToolResult:
    """Create an AssignmentProposal from agent recommendation.

    risk_category=draft_only, effects.effect_type=proposal_create.
    Creates an AssignmentProposal without writing Task.owner_user_id.
    Final owner is only written by finalize_assignment_proposal (human-triggered).
    """
    args = request.arguments or {}
    project_id = request.project_id
    workspace_id = request.workspace_id

    # Validate required fields
    required = ["stage_id", "task_id", "recommended_owner_user_id", "reason"]
    missing = [f for f in required if not args.get(f)]
    if missing:
        return ProjectFlowToolResult(
            status=ToolResultStatus.validation_error,
            side_effect_status=SideEffectStatus.no_side_effect,
            observation=f"缺少必填字段：{', '.join(missing)}",
        )

    try:
        create_data = AssignmentProposalCreate(
            project_id=project_id,
            stage_id=args["stage_id"],
            task_id=args["task_id"],
            recommended_owner_user_id=args["recommended_owner_user_id"],
            backup_owner_user_id=args.get("backup_owner_user_id"),
            reason=args["reason"],
            skill_match=args.get("skill_match"),
            availability_match=args.get("availability_match"),
            preference_match=args.get("preference_match"),
            constraint_respected=args.get("constraint_respected"),
            risk_note=args.get("risk_note"),
            created_by_agent=True,
        )
        proposal = create_assignment_proposal(session, create_data, auto_commit=False)
        owner_user = session.get(User, args["recommended_owner_user_id"])
        owner_name = owner_user.display_name if owner_user else args["recommended_owner_user_id"]
        event = AgentEvent(
            project_id=project_id,
            workspace_id=workspace_id,
            event_type=AgentEventType.assign,
            reasoning_summary="分工建议工具创建待确认分工草案。",
        )
        event.set_input_snapshot(
            {
                "tool_idempotency_key": request.idempotency_key,
                "tool_call_id": request.tool_call_id,
                "tool_name": request.tool_name,
                "tool_dispatch_name": "assignment-recommendation",
            }
        )
        result = _assignment_tool_result(
            proposal,
            request=request,
            agent_event_id=event.id,
            observation=f"分工建议已创建：推荐 {owner_name} 负责任务。",
        )
        event.set_output_snapshot({"tool_result": result.model_dump(mode="json")})
        session.add(event)
        session.commit()
        session.refresh(proposal)

        return result
    except (ValueError, ValidationError) as exc:
        return _assignment_validation_error_result(exc)


def _assignment_tool_result(
    proposal: AssignmentProposal,
    *,
    request: ToolExecutionRequest,
    agent_event_id: str | None,
    observation: str,
) -> ProjectFlowToolResult:
    read_schema = AssignmentProposalRead.model_validate(proposal, from_attributes=True)
    return ProjectFlowToolResult(
        status=ToolResultStatus.success,
        data=read_schema.model_dump(mode="json"),
        side_effect_status=SideEffectStatus.proposal_persisted,
        idempotency_key=request.idempotency_key,
        links=ToolLinks(
            agent_event_id=agent_event_id,
            proposal_id=proposal.id,
            created_ids=[proposal.id],
        ),
        observation=observation,
    )


def _assignment_validation_error_result(exc: ValueError | ValidationError) -> ProjectFlowToolResult:
    raw_message = str(exc)
    lower_message = raw_message.lower()
    if "already has owner" in lower_message:
        message = "该任务已有负责人，不能通过分工建议工具重复分配。"
    elif "already has a proposal" in lower_message or "already has proposal" in lower_message:
        message = "该任务已有待处理的分工建议，请先处理现有建议后再生成新的建议。"
    elif "previously rejected" in lower_message:
        message = "该任务和负责人组合曾被拒绝，请推荐其他负责人。"
    elif "backup owner must differ" in lower_message:
        message = "备选负责人必须不同于推荐负责人。"
    elif "not a workspace member" in lower_message:
        message = "推荐负责人或备选负责人不是当前工作区成员。"
    elif "stage does not belong" in lower_message:
        message = "所选阶段不属于当前项目。"
    elif "task does not belong to the specified stage" in lower_message:
        message = "所选任务不属于当前阶段。"
    elif "task does not belong" in lower_message:
        message = "所选任务不属于当前项目。"
    elif isinstance(exc, ValidationError):
        message = "分工建议参数格式不合法，请补齐必填字段并检查字段类型。"
    else:
        message = "分工建议未通过业务校验，请检查任务、阶段和成员是否匹配。"

    return ProjectFlowToolResult(
        status=ToolResultStatus.validation_error,
        error=ToolError(code="ASSIGNMENT_RECOMMENDATION_INVALID", reason=message, message=message),
        side_effect_status=SideEffectStatus.no_side_effect,
        observation=message,
    )


# ─── S11: create_risk / create_checkin ─────────────────────────────────────


def execute_create_risk(session: Session, request: ToolExecutionRequest) -> ProjectFlowToolResult:
    """Create a Risk record directly (advisory_write).

    risk_category=advisory_write, proposalConfirmRequired=false.
    Risk rows are advisory — no proposal confirmation gate.
    Idempotent: same idempotency_key returns cached result.
    """
    args = request.arguments or {}
    project_id = request.project_id

    # Idempotency check: look for existing event with same idempotency key
    import json as json_check
    if request.idempotency_key:
        existing_event = session.exec(
            select(AgentEvent).where(
                AgentEvent.project_id == project_id,
                AgentEvent.event_type == AgentEventType.risk,
            )
        ).all()
        for evt in existing_event:
            snapshot = evt.input_snapshot or {}
            if isinstance(snapshot, str):
                snapshot = json_check.loads(snapshot)
            if snapshot.get("tool_idempotency_key") == request.idempotency_key:
                # Return cached result
                output = evt.output_snapshot or {}
                if isinstance(output, str):
                    output = json_check.loads(output)
                tool_result = output.get("tool_result", {})
                if tool_result:
                    return ProjectFlowToolResult(**tool_result)

    required = ["type", "severity", "title", "description", "evidence", "recommendation"]
    missing = [f for f in required if not args.get(f)]
    if missing:
        return ProjectFlowToolResult(
            status=ToolResultStatus.validation_error,
            side_effect_status=SideEffectStatus.no_side_effect,
            observation=f"缺少必填字段：{', '.join(missing)}",
        )

    try:
        stage_id = args.get("stage_id")
        task_id = args.get("task_id")
        if stage_id:
            stage = session.get(Stage, stage_id)
            if stage is None:
                return ProjectFlowToolResult(
                    status=ToolResultStatus.validation_error,
                    side_effect_status=SideEffectStatus.no_side_effect,
                    observation="阶段不存在。",
                )
            if stage.project_id != project_id:
                return ProjectFlowToolResult(
                    status=ToolResultStatus.validation_error,
                    side_effect_status=SideEffectStatus.no_side_effect,
                    observation="阶段不属于当前项目。",
                )
        if task_id:
            task = session.get(Task, task_id)
            if task is None:
                return ProjectFlowToolResult(
                    status=ToolResultStatus.validation_error,
                    side_effect_status=SideEffectStatus.no_side_effect,
                    observation="任务不存在。",
                )
            if task.project_id != project_id:
                return ProjectFlowToolResult(
                    status=ToolResultStatus.validation_error,
                    side_effect_status=SideEffectStatus.no_side_effect,
                    observation="任务不属于当前项目。",
                )
            if stage_id and task.stage_id != stage_id:
                return ProjectFlowToolResult(
                    status=ToolResultStatus.validation_error,
                    side_effect_status=SideEffectStatus.no_side_effect,
                    observation="任务不属于所选阶段。",
                )

        create_data = RiskCreate(
            project_id=project_id,
            stage_id=stage_id,
            task_id=task_id,
            type=args["type"],
            severity=args["severity"],
            title=args["title"],
            description=args["description"],
            evidence=args["evidence"],
            recommendation=args["recommendation"],
            created_by_agent=True,
        )
        risk = create_risk(session, create_data, auto_commit=False)

        event = AgentEvent(
            project_id=project_id,
            workspace_id=request.workspace_id,
            event_type=AgentEventType.risk,
            reasoning_summary="风险工具创建风险记录。",
        )
        event.set_input_snapshot({
            "tool_idempotency_key": request.idempotency_key,
            "tool_call_id": request.tool_call_id,
            "tool_name": request.tool_name,
            "tool_dispatch_name": "create-risk",
        })
        # Parse evidence from JSON string to list for schema validation
        import json as json_module
        risk_dict = risk.__dict__.copy()
        if isinstance(risk_dict.get("evidence"), str):
            risk_dict["evidence"] = json_module.loads(risk_dict["evidence"])
        read_data = RiskRead.model_validate(risk_dict).model_dump(mode="json")
        result = ProjectFlowToolResult(
            status=ToolResultStatus.success,
            data=read_data,
            side_effect_status=SideEffectStatus.advisory_record_persisted,
            idempotency_key=request.idempotency_key,
            links=ToolLinks(agent_event_id=event.id, created_ids=[risk.id]),
            observation=f"风险已创建：{risk.title}。",
        )
        event.set_output_snapshot({"tool_result": result.model_dump(mode="json")})
        session.add(event)
        session.commit()
        session.refresh(risk)
        return result
    except (ValueError, ValidationError) as exc:
        session.rollback()
        return ProjectFlowToolResult(
            status=ToolResultStatus.validation_error,
            side_effect_status=SideEffectStatus.no_side_effect,
            observation=str(exc),
        )


def execute_create_checkin(session: Session, request: ToolExecutionRequest) -> ProjectFlowToolResult:
    """Create a CheckInCycle + initial CheckInResponse (advisory_write).

    risk_category=advisory_write, proposalConfirmRequired=false.
    Idempotent: same idempotency_key returns cached result.
    """
    args = request.arguments or {}
    project_id = request.project_id

    # Idempotency check: look for existing event with same idempotency key
    import json as json_check2
    if request.idempotency_key:
        existing_event = session.exec(
            select(AgentEvent).where(
                AgentEvent.project_id == project_id,
                AgentEvent.event_type == AgentEventType.checkin,
            )
        ).all()
        for evt in existing_event:
            snapshot = evt.input_snapshot or {}
            if isinstance(snapshot, str):
                snapshot = json_check2.loads(snapshot)
            if snapshot.get("tool_idempotency_key") == request.idempotency_key:
                # Return cached result
                output = evt.output_snapshot or {}
                if isinstance(output, str):
                    output = json_check2.loads(output)
                tool_result = output.get("tool_result", {})
                if tool_result:
                    return ProjectFlowToolResult(**tool_result)

    required = ["task_id", "what_done"]
    missing = [f for f in required if not args.get(f)]
    if missing:
        return ProjectFlowToolResult(
            status=ToolResultStatus.validation_error,
            side_effect_status=SideEffectStatus.no_side_effect,
            observation=f"缺少必填字段：{', '.join(missing)}",
        )

    try:
        task = session.get(Task, args["task_id"])
        if not task:
            return ProjectFlowToolResult(
                status=ToolResultStatus.validation_error,
                side_effect_status=SideEffectStatus.no_side_effect,
                observation="任务不存在。",
            )
        if task.project_id != project_id:
            return ProjectFlowToolResult(
                status=ToolResultStatus.validation_error,
                side_effect_status=SideEffectStatus.no_side_effect,
                observation="任务不属于当前项目。",
            )

        stage_id = args.get("stage_id") or task.stage_id
        if stage_id != task.stage_id:
            return ProjectFlowToolResult(
                status=ToolResultStatus.validation_error,
                side_effect_status=SideEffectStatus.no_side_effect,
                observation="签到阶段必须与任务所属阶段一致。",
            )

        user_id = args.get("user_id")
        if not user_id:
            return ProjectFlowToolResult(
                status=ToolResultStatus.validation_error,
                side_effect_status=SideEffectStatus.no_side_effect,
                observation="缺少用户身份信息。",
            )
        membership = session.exec(
            select(WorkspaceMembership).where(
                WorkspaceMembership.workspace_id == request.workspace_id,
                WorkspaceMembership.user_id == user_id,
            )
        ).first()
        if membership is None:
            return ProjectFlowToolResult(
                status=ToolResultStatus.validation_error,
                side_effect_status=SideEffectStatus.no_side_effect,
                observation="用户不是当前工作区成员。",
            )

        from datetime import date as date_type

        cycle_data = CheckInCycleCreate(
            project_id=project_id,
            stage_id=stage_id,
            cadence_days=args.get("cadence_days", 2),
            start_date=args.get("start_date", str(date_type.today())),
            created_by_user_id=user_id,
        )
        cycle = create_checkin_cycle(session, cycle_data, auto_commit=False)

        response_data = CheckInResponseCreate(
            project_id=project_id,
            stage_id=stage_id,
            user_id=user_id,
            task_id=args["task_id"],
            what_done=args["what_done"],
            blocker=args.get("blocker"),
            available_hours_next_cycle=args.get("available_hours_next_cycle"),
            mood_or_confidence=args.get("mood_or_confidence"),
        )
        response = create_checkin_response(session, cycle.id, response_data, auto_commit=False)

        event = AgentEvent(
            project_id=project_id,
            workspace_id=request.workspace_id,
            event_type=AgentEventType.checkin,
            reasoning_summary="签到工具创建签到记录。",
        )
        event.set_input_snapshot({
            "tool_idempotency_key": request.idempotency_key,
            "tool_call_id": request.tool_call_id,
            "tool_name": request.tool_name,
            "tool_dispatch_name": "create-checkin",
        })
        cycle_read = CheckInCycleRead.model_validate(cycle, from_attributes=True).model_dump(mode="json")
        response_read = CheckInResponseRead.model_validate(response, from_attributes=True).model_dump(mode="json")
        read_data = {"cycle": cycle_read, "responses": [response_read]}
        result = ProjectFlowToolResult(
            status=ToolResultStatus.success,
            data=read_data,
            side_effect_status=SideEffectStatus.advisory_record_persisted,
            idempotency_key=request.idempotency_key,
            links=ToolLinks(agent_event_id=event.id, created_ids=[cycle.id, response.id]),
            observation="签到记录已创建。",
        )
        event.set_output_snapshot({"tool_result": result.model_dump(mode="json")})
        session.add(event)
        session.commit()
        session.refresh(response)
        return result
    except (ValueError, ValidationError) as exc:
        session.rollback()
        return ProjectFlowToolResult(
            status=ToolResultStatus.validation_error,
            side_effect_status=SideEffectStatus.no_side_effect,
            observation=str(exc),
        )


# ─── Tool dispatch ─────────────────────────────────────────────────────────


def execute_tool(session: Session, request: ToolExecutionRequest) -> ProjectFlowToolResult:
    """Backward-compatible wrapper for unified tool dispatch."""
    return execute_agent_tool(session, request)


__all__ = [
    "execute_agent_tool",
    "execute_read_only_tool",
    "execute_assignment_recommendation",
    "execute_tool",
    "ToolNotFoundError",
    "WorkspaceStateResponse",
    "AgentConversationRead",
    "AgentProposalRead",
]
