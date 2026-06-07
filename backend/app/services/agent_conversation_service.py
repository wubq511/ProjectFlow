import json
import time
from datetime import UTC, datetime
from html import escape
from typing import Any, Iterator

from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, desc, select

from app.agent.llm_client import LLMClient, build_agent_llm_client
from app.models import AgentEvent, AgentProposal, Project
from app.models.agent_conversation import AgentConversation, AgentMessage, AgentRun
from app.models.enums import AgentEventType
from app.schemas.agent_conversation import (
    AgentArtifactRead,
    AgentConversationRead,
    AgentConversationTurnRead,
    AgentMessageRead,
    AgentRunRead,
    AgentSuggestionRead,
    AgentTurnPlan,
)
from app.services.agent_flow_service import run_agent_flow
from app.services.workspace_state_service import get_workspace_state


MODULE_EVENT_TYPE: dict[str, AgentEventType] = {
    "clarify": AgentEventType.clarify,
    "plan": AgentEventType.plan,
    "breakdown": AgentEventType.breakdown,
    "assign": AgentEventType.assign,
    "push": AgentEventType.push,
    "checkin": AgentEventType.checkin,
    "risk": AgentEventType.risk,
    "replan": AgentEventType.replan,
}

MODULE_ARTIFACT_LABEL: dict[str, str] = {
    "clarify": "方向卡",
    "plan": "阶段计划",
    "breakdown": "任务拆解",
    "assign": "分工建议",
    "push": "下一步行动卡",
    "checkin": "签到分析",
    "risk": "风险分析",
    "replan": "计划调整建议",
}


def _sse_event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


MODULE_STATUS_MESSAGES: dict[str, str] = {
    "clarify": "正在澄清项目方向",
    "plan": "正在生成阶段计划",
    "breakdown": "正在拆解任务",
    "assign": "正在推荐分工",
    "push": "正在生成行动卡",
    "checkin": "正在分析签到状态",
    "risk": "正在分析风险",
    "replan": "正在调整计划",
}


def get_or_create_project_conversation(
    session: Session,
    project_id: str,
) -> AgentConversation:
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError("Project not found")

    existing = session.exec(
        select(AgentConversation)
        .where(
            AgentConversation.project_id == project_id,
            AgentConversation.status == "active",
        )
        .order_by(desc(AgentConversation.updated_at))
    ).first()
    if existing:
        return existing

    conversation = AgentConversation(
        workspace_id=project.workspace_id,
        project_id=project.id,
        current_focus=_focus_for_project(project),
    )
    session.add(conversation)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        existing = session.exec(
            select(AgentConversation)
            .where(AgentConversation.project_id == project_id)
            .order_by(desc(AgentConversation.updated_at))
        ).first()
        if existing:
            return existing
        raise
    session.refresh(conversation)
    return conversation


def read_project_conversation(session: Session, project_id: str) -> AgentConversationRead:
    conversation = get_or_create_project_conversation(session, project_id)
    return _conversation_to_read(session, conversation)


def process_conversation_message(
    session: Session,
    conversation_id: str,
    content: str,
    *,
    llm_client: LLMClient | None = None,
) -> AgentConversationTurnRead:
    conversation = session.get(AgentConversation, conversation_id)
    if conversation is None:
        raise ValueError("Agent conversation not found")
    project = session.get(Project, conversation.project_id)
    if project is None:
        raise ValueError("Project not found")

    llm = llm_client or build_agent_llm_client()
    workspace_state = get_workspace_state(
        session,
        conversation.workspace_id,
        project_id=conversation.project_id,
    )
    if workspace_state is None or workspace_state.project is None:
        raise ValueError("Workspace state not found")

    user_message = AgentMessage(
        conversation_id=conversation.id,
        role="user",
        content=content,
    )
    session.add(user_message)
    session.flush()

    turn_plan = _plan_turn(
        llm,
        content=content,
        conversation=conversation,
        workspace_state=workspace_state,
        recent_messages=_recent_messages(session, conversation.id),
    )

    blocked_reason = _policy_block_reason(turn_plan, workspace_state)
    run_read: AgentRunRead | None = None
    linked_event_id: str | None = None
    linked_proposal_id: str | None = None
    artifacts: list[AgentArtifactRead] = []

    if blocked_reason:
        assistant_content = blocked_reason
    elif turn_plan.response_type in {"answer", "ask_clarifying_question"} or not turn_plan.selected_module:
        assistant_content = _answer_content(turn_plan, workspace_state)
    else:
        flow_result = _run_selected_module(
            session,
            conversation.workspace_id,
            conversation.project_id,
            turn_plan,
            llm,
        )
        event_type = MODULE_EVENT_TYPE[turn_plan.selected_module]
        linked_event_id = _latest_agent_event_id(
            session,
            conversation.project_id,
            conversation.workspace_id,
            event_type,
        )
        linked_proposal_id = flow_result.proposal_id
        run = AgentRun(
            conversation_id=conversation.id,
            project_id=conversation.project_id,
            user_instruction=turn_plan.user_instruction or content,
            selected_module=turn_plan.selected_module,
            status="proposal_created" if flow_result.proposal_id else "completed",
            model=_client_model(llm),
            attempts=flow_result.attempts,
            verifier_status="passed",
            agent_event_id=linked_event_id,
            proposal_id=flow_result.proposal_id,
            completed_at=datetime.now(UTC),
        )
        session.add(run)
        session.flush()
        run_read = _run_to_read(run)
        assistant_content = _success_content(turn_plan, flow_result.proposal_id)
        artifacts = _artifacts_from_flow_result(session, flow_result, turn_plan)

    next_labels = _next_suggestions(workspace_state)
    suggestions = _structured_suggestions(next_labels)

    assistant_message = AgentMessage(
        conversation_id=conversation.id,
        role="assistant",
        content=assistant_content,
        linked_event_id=linked_event_id,
        linked_proposal_id=linked_proposal_id,
    )
    assistant_message.set_structured_payload(
        {
            "turn_plan": turn_plan.model_dump(mode="json"),
            "blocked_reason": blocked_reason,
            "next_suggestions": next_labels,
            "suggestions": [suggestion.model_dump(mode="json") for suggestion in suggestions],
            "artifacts": [artifact.model_dump(mode="json") for artifact in artifacts],
        }
    )
    session.add(assistant_message)

    conversation.current_focus = _focus_for_workspace_state(workspace_state)
    conversation.updated_at = datetime.now(UTC)
    session.add(conversation)
    session.commit()
    session.refresh(user_message)
    session.refresh(assistant_message)

    return AgentConversationTurnRead(
        conversation=_conversation_to_read(session, conversation),
        user_message=_message_to_read(user_message),
        assistant_message=_message_to_read(assistant_message),
        run=run_read,
        turn_plan=turn_plan,
        next_suggestions=next_labels,
        suggestions=suggestions,
        artifacts=artifacts,
    )


def process_conversation_message_stream(
    session: Session,
    conversation_id: str,
    content: str,
    *,
    llm_client: LLMClient | None = None,
) -> Iterator[str]:
    """Yield SSE event strings for a conversation turn."""
    conversation = session.get(AgentConversation, conversation_id)
    if conversation is None:
        yield _sse_event("error", {"message": "对话不存在"})
        return
    project = session.get(Project, conversation.project_id)
    if project is None:
        yield _sse_event("error", {"message": "项目不存在"})
        return

    llm = llm_client or build_agent_llm_client()
    workspace_state = get_workspace_state(
        session,
        conversation.workspace_id,
        project_id=conversation.project_id,
    )
    if workspace_state is None or workspace_state.project is None:
        yield _sse_event("error", {"message": "工作区状态不存在"})
        return

    # Save user message
    user_message = AgentMessage(
        conversation_id=conversation.id,
        role="user",
        content=content,
    )
    session.add(user_message)
    session.flush()

    # Phase: planning
    yield _sse_event("status", {"phase": "planning", "message": "正在理解你的需求..."})

    turn_plan = _plan_turn(
        llm,
        content=content,
        conversation=conversation,
        workspace_state=workspace_state,
        recent_messages=_recent_messages(session, conversation.id),
    )

    blocked_reason = _policy_block_reason(turn_plan, workspace_state)
    run_read: AgentRunRead | None = None
    linked_event_id: str | None = None
    linked_proposal_id: str | None = None
    artifacts: list[AgentArtifactRead] = []

    if blocked_reason:
        yield _sse_event("status", {"phase": "answering", "message": "正在整理回复..."})
        assistant_content = blocked_reason
    elif turn_plan.response_type in {"answer", "ask_clarifying_question"} or not turn_plan.selected_module:
        yield _sse_event("status", {"phase": "answering", "message": "正在整理回复..."})
        assistant_content = _answer_content(turn_plan, workspace_state)
    else:
        module = turn_plan.selected_module
        status_msg = MODULE_STATUS_MESSAGES.get(module, f"正在执行 {module}")
        yield _sse_event("status", {"phase": "executing", "module": module, "message": status_msg})

        flow_result = _run_selected_module(
            session,
            conversation.workspace_id,
            conversation.project_id,
            turn_plan,
            llm,
        )
        event_type = MODULE_EVENT_TYPE[module]
        linked_event_id = _latest_agent_event_id(
            session,
            conversation.project_id,
            conversation.workspace_id,
            event_type,
        )
        linked_proposal_id = flow_result.proposal_id
        run = AgentRun(
            conversation_id=conversation.id,
            project_id=conversation.project_id,
            user_instruction=turn_plan.user_instruction or content,
            selected_module=module,
            status="proposal_created" if flow_result.proposal_id else "completed",
            model=_client_model(llm),
            attempts=flow_result.attempts,
            verifier_status="passed",
            agent_event_id=linked_event_id,
            proposal_id=flow_result.proposal_id,
            completed_at=datetime.now(UTC),
        )
        session.add(run)
        session.flush()
        run_read = _run_to_read(run)
        assistant_content = _success_content(turn_plan, flow_result.proposal_id)
        artifacts = _artifacts_from_flow_result(session, flow_result, turn_plan)

        yield _sse_event("status", {"phase": "generating", "message": "正在整理结果..."})

    # Phase: stream the final reply
    yield _sse_event("status", {"phase": "streaming", "message": "正在生成回复..."})

    # Stream the pre-generated assistant content character by character
    for char in assistant_content:
        yield _sse_event("token", {"content": char})
        time.sleep(0.005)

    full_response = assistant_content

    # Save assistant message
    next_labels = _next_suggestions(workspace_state)
    suggestions = _structured_suggestions(next_labels)

    assistant_message = AgentMessage(
        conversation_id=conversation.id,
        role="assistant",
        content=full_response,
        linked_event_id=linked_event_id,
        linked_proposal_id=linked_proposal_id,
    )
    assistant_message.set_structured_payload(
        {
            "turn_plan": turn_plan.model_dump(mode="json"),
            "blocked_reason": blocked_reason,
            "next_suggestions": next_labels,
            "suggestions": [s.model_dump(mode="json") for s in suggestions],
            "artifacts": [a.model_dump(mode="json") for a in artifacts],
        }
    )
    session.add(assistant_message)

    conversation.current_focus = _focus_for_workspace_state(workspace_state)
    conversation.updated_at = datetime.now(UTC)
    session.add(conversation)
    session.commit()
    session.refresh(user_message)
    session.refresh(assistant_message)

    # Done event with full turn data
    turn = AgentConversationTurnRead(
        conversation=_conversation_to_read(session, conversation),
        user_message=_message_to_read(user_message),
        assistant_message=_message_to_read(assistant_message),
        run=run_read,
        turn_plan=turn_plan,
        next_suggestions=next_labels,
        suggestions=suggestions,
        artifacts=artifacts,
    )
    yield _sse_event("done", turn.model_dump(mode="json"))


def _plan_turn(
    llm_client: LLMClient,
    *,
    content: str,
    conversation: AgentConversation,
    workspace_state,
    recent_messages: list[AgentMessage],
) -> AgentTurnPlan:
    messages = [
        {
            "role": "system",
            "content": (
                "You are ProjectFlow's Agent conversation planner. Return exactly one JSON object "
                "matching AgentTurnPlan. Decide whether to answer, ask a clarifying question, run an "
                "agent module, or revise a pending proposal. Do not produce business artifacts here.\n\n"
                "When the user message is a quick reply action label (短快捷回复标签), you MUST return "
                "response_type='run_module' with the correct selected_module. These are the known mappings:\n"
                "- 用户说「生成下一步行动卡」或类似 → response_type='run_module', selected_module='push'\n"
                "- 用户说「分析当前风险」或类似 → response_type='run_module', selected_module='risk'\n"
                "- 用户说「根据签到调整计划」或类似 → response_type='run_module', selected_module='replan'\n"
                "- 用户说「根据成员情况推荐分工」或类似 → response_type='run_module', selected_module='assign'\n"
                "- 用户说「把当前阶段拆成任务」或类似 → response_type='run_module', selected_module='breakdown'\n"
                "- 用户说「按三周节奏生成阶段计划」或类似 → response_type='run_module', selected_module='plan'\n"
                "- 用户说「先帮我澄清方向」或类似 → response_type='run_module', selected_module='clarify'\n\n"
                "Even if the user message is very short (just a label), treat action-like labels as "
                "module execution requests, not as casual conversation."
            ),
        },
        {
            "role": "user",
            "content": (
                f"<conversation id=\"{conversation.id}\" project_id=\"{conversation.project_id}\" />\n"
                f"<recent_messages>\n{_messages_json(recent_messages)}\n</recent_messages>\n\n"
                f"<workspace_state>\n{workspace_state.model_dump_json()}\n</workspace_state>\n\n"
                "<allowed_modules>clarify, plan, breakdown, assign, push, checkin, risk, replan</allowed_modules>\n"
                f"<user_message>\n{escape(content, quote=False)}\n</user_message>"
            ),
        },
    ]
    try:
        raw = llm_client.complete(messages, max_tokens=1200)
        return _parse_turn_plan(raw, content)
    except (json.JSONDecodeError, TypeError, ValidationError, ValueError):
        return AgentTurnPlan(
            response_type="answer",
            selected_module=None,
            user_instruction=content,
            rationale="Planner 输出不可用，按当前项目状态给出安全引导。",
            required_inputs=[],
            expected_artifact=None,
            risk_level="low",
            requires_confirmation=False,
        )


def _parse_turn_plan(raw: str, user_message: str) -> AgentTurnPlan:
    payload = _load_planner_json(raw)
    normalized = _normalize_turn_plan_payload(payload, user_message)
    return AgentTurnPlan.model_validate(normalized)


def _load_planner_json(raw: str) -> dict[str, Any]:
    text = raw.strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        if text.startswith("```"):
            text = text.removeprefix("```json").removeprefix("```").strip()
            if text.endswith("```"):
                text = text[:-3].strip()
        first = text.find("{")
        last = text.rfind("}")
        if first < 0 or last < first:
            raise
        payload = json.loads(text[first:last + 1])
    if not isinstance(payload, dict):
        raise ValueError("planner output must be a JSON object")
    for key in ("turn_plan", "plan", "decision", "action"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            return nested
    return payload


def _normalize_turn_plan_payload(payload: dict[str, Any], user_message: str) -> dict[str, Any]:
    response_type_value = payload.get("response_type") or payload.get("type")
    selected_module = _string_or_none(
        payload.get("selected_module")
        or payload.get("module")
        or payload.get("agent_module")
        or payload.get("tool")
    )
    if selected_module is None and _string_or_none(response_type_value) in MODULE_EVENT_TYPE:
        selected_module = _string_or_none(response_type_value)
    if selected_module not in MODULE_EVENT_TYPE:
        selected_module = None

    response_type = _normalize_response_type(response_type_value, selected_module)
    user_instruction = _string_or_none(
        payload.get("user_instruction")
        or payload.get("instruction")
        or payload.get("userInstruction")
        or payload.get("request")
    ) or user_message
    required_inputs = payload.get("required_inputs") or payload.get("requiredInputs") or []
    if isinstance(required_inputs, str):
        required_inputs = [required_inputs]
    if not isinstance(required_inputs, list):
        required_inputs = []

    direct_answer = _string_or_none(
        payload.get("assistant_response")
        or payload.get("assistantResponse")
        or payload.get("content")
        or payload.get("message")
        or payload.get("answer")
    )
    rationale = _string_or_none(payload.get("rationale") or payload.get("reason") or payload.get("explanation"))
    if not rationale:
        if response_type in {"answer", "ask_clarifying_question"} and direct_answer:
            rationale = direct_answer
        elif response_type in {"answer", "ask_clarifying_question"}:
            rationale = "我在。你可以直接告诉我想推进的事项，例如分析当前风险、生成下一步行动卡或根据签到调整计划。"
        elif response_type == "run_module" and selected_module:
            rationale = f"LLM planner selected the {selected_module} module."
        else:
            rationale = "我会根据当前项目状态继续推进。"

    expected_artifact = _string_or_none(
        payload.get("expected_artifact")
        or payload.get("expectedArtifact")
        or payload.get("artifact")
    )
    if not expected_artifact and selected_module:
        expected_artifact = MODULE_ARTIFACT_LABEL[selected_module]

    return {
        "response_type": response_type,
        "selected_module": selected_module,
        "user_instruction": user_instruction,
        "rationale": rationale,
        "required_inputs": required_inputs,
        "expected_artifact": expected_artifact,
        "risk_level": _normalize_risk_level(payload.get("risk_level") or payload.get("riskLevel")),
        "requires_confirmation": _normalize_bool(
            payload.get("requires_confirmation", payload.get("requiresConfirmation", False))
        ),
    }


def _normalize_response_type(value: Any, selected_module: str | None) -> str:
    raw = _string_or_none(value)
    if raw in MODULE_EVENT_TYPE:
        return "run_module"
    if selected_module and raw in {None, "", "run", "execute", "tool", "module", "action"}:
        return "run_module"
    aliases = {
        "run": "run_module",
        "execute": "run_module",
        "tool": "run_module",
        "module": "run_module",
        "action": "run_module",
        "ask": "ask_clarifying_question",
        "question": "ask_clarifying_question",
        "clarifying_question": "ask_clarifying_question",
        "revise": "revise_pending_proposal",
        "revision": "revise_pending_proposal",
    }
    return aliases.get(raw or "", raw or "answer")


def _normalize_risk_level(value: Any) -> str:
    raw = _string_or_none(value) or "low"
    return raw if raw in {"low", "medium", "high"} else "low"


def _normalize_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return bool(value)


def _string_or_none(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _policy_block_reason(turn_plan: AgentTurnPlan, workspace_state) -> str | None:
    module = turn_plan.selected_module
    project = workspace_state.project
    if turn_plan.response_type not in {"run_module", "revise_pending_proposal"} or not module:
        return None
    if project is None:
        return "当前还没有项目，先创建项目后我才能继续推进。"
    if module == "plan" and not project.direction_card:
        return "现在还不能生成阶段计划，因为项目方向卡还没有确认。先完成方向澄清，我再按你的要求规划阶段。"
    if module == "breakdown" and not project.stages:
        return "现在还不能拆解任务，因为还没有已确认的阶段计划。先生成并确认阶段计划后，我再按阶段拆任务。"
    if module == "assign" and not project.tasks:
        return "现在还不能推荐分工，因为任务还没有拆解出来。先确认任务拆解后，我再根据成员情况推荐 owner。"
    if module == "push" and not _has_finalized_assignment(project):
        return "现在还不能主动推进，因为分工还没有最终确认。先完成分工确认后，我再生成推进行动卡。"
    if module in {"risk", "replan"} and not project.tasks:
        return "现在还不能分析风险或重排计划，因为项目还没有任务状态。先拆解任务并进入执行后再分析。"
    if module == "replan" and not project.stages:
        return "现在还不能重排计划，因为还没有可调整的阶段计划。"
    return None


def _run_selected_module(
    session: Session,
    workspace_id: str,
    project_id: str,
    turn_plan: AgentTurnPlan,
    llm_client: LLMClient,
):
    module = turn_plan.selected_module
    instruction = turn_plan.user_instruction
    if module == "clarify":
        method = lambda coordinator, state, user_instruction: coordinator.generate_direction_card(  # noqa: E731
            state,
            user_instruction=user_instruction,
        )
    elif module == "plan":
        method = lambda coordinator, state, user_instruction: coordinator.generate_stage_plan(  # noqa: E731
            state,
            user_instruction=user_instruction,
        )
    elif module == "breakdown":
        method = lambda coordinator, state, user_instruction: coordinator.generate_task_breakdown(  # noqa: E731
            state,
            user_instruction=user_instruction,
        )
    elif module == "assign":
        method = lambda coordinator, state, user_instruction: coordinator.recommend_assignments(  # noqa: E731
            state,
            user_instruction=user_instruction,
        )
    elif module == "push":
        method = lambda coordinator, state, user_instruction: coordinator.create_active_push(  # noqa: E731
            state,
            user_instruction=user_instruction,
        )
    elif module == "checkin":
        method = lambda coordinator, state, user_instruction: coordinator.analyze_checkin(  # noqa: E731
            state,
            user_instruction=user_instruction,
        )
    elif module == "risk":
        method = lambda coordinator, state, user_instruction: coordinator.analyze_risks(  # noqa: E731
            state,
            user_instruction=user_instruction,
        )
    elif module == "replan":
        method = lambda coordinator, state, user_instruction: coordinator.replan(  # noqa: E731
            state,
            user_instruction=user_instruction,
        )
    else:
        raise ValueError(f"Unsupported agent module: {module}")
    return run_agent_flow(
        session,
        workspace_id,
        method,
        project_id=project_id,
        user_instruction=instruction,
        llm_client=llm_client,
    )


def _latest_agent_event_id(
    session: Session,
    project_id: str,
    workspace_id: str,
    event_type: AgentEventType,
) -> str | None:
    event = session.exec(
        select(AgentEvent)
        .where(
            AgentEvent.project_id == project_id,
            AgentEvent.workspace_id == workspace_id,
            AgentEvent.event_type == event_type,
        )
        .order_by(desc(AgentEvent.created_at))
    ).first()
    return event.id if event else None


def _conversation_to_read(session: Session, conversation: AgentConversation) -> AgentConversationRead:
    messages = session.exec(
        select(AgentMessage)
        .where(AgentMessage.conversation_id == conversation.id)
        .order_by(AgentMessage.created_at)
    ).all()
    return AgentConversationRead(
        id=conversation.id,
        workspace_id=conversation.workspace_id,
        project_id=conversation.project_id,
        status=conversation.status,
        summary=conversation.summary,
        current_focus=conversation.current_focus,
        messages=[_message_to_read(message) for message in messages],
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


def _message_to_read(message: AgentMessage) -> AgentMessageRead:
    return AgentMessageRead(
        id=message.id,
        conversation_id=message.conversation_id,
        role=message.role,
        content=message.content,
        structured_payload=message.get_structured_payload(),
        linked_event_id=message.linked_event_id,
        linked_proposal_id=message.linked_proposal_id,
        created_at=message.created_at,
    )


def _run_to_read(run: AgentRun) -> AgentRunRead:
    return AgentRunRead(
        id=run.id,
        conversation_id=run.conversation_id,
        project_id=run.project_id,
        user_instruction=run.user_instruction,
        selected_module=run.selected_module,
        status=run.status,
        model=run.model,
        attempts=run.attempts,
        verifier_status=run.verifier_status,
        agent_event_id=run.agent_event_id,
        proposal_id=run.proposal_id,
        created_at=run.created_at,
        completed_at=run.completed_at,
    )


def _recent_messages(session: Session, conversation_id: str) -> list[AgentMessage]:
    return session.exec(
        select(AgentMessage)
        .where(AgentMessage.conversation_id == conversation_id)
        .order_by(desc(AgentMessage.created_at))
        .limit(8)
    ).all()


def _messages_json(messages: list[AgentMessage]) -> str:
    return json.dumps(
        [
            {
                "role": message.role,
                "content": message.content,
                "created_at": message.created_at.isoformat(),
            }
            for message in reversed(messages)
        ],
        ensure_ascii=False,
    )


def _focus_for_project(project: Project) -> str:
    if not project.direction_card:
        return "方向澄清"
    return "阶段计划"


def _focus_for_workspace_state(workspace_state) -> str:
    project = workspace_state.project
    if not project:
        return "创建项目"
    if not project.direction_card:
        return "方向澄清"
    if not project.stages:
        return "阶段计划"
    if not project.tasks:
        return "任务拆解"
    if not _has_finalized_assignment(project):
        return "分工确认"
    return "执行推进"


def _has_finalized_assignment(project) -> bool:
    return any(proposal.status == "finalized" for proposal in project.assignment_proposals)


QUICK_REPLY_INSTRUCTION_MAP: dict[str, str] = {
    "生成下一步行动卡": "请执行 push 模块：生成下一步行动卡。用户点击了快捷回复「生成下一步行动卡」，请直接运行 push 模块生成行动卡。",
    "分析当前风险": "请执行 risk 模块：分析当前风险。用户点击了快捷回复「分析当前风险」，请直接运行 risk 模块进行风险分析。",
    "根据签到调整计划": "请执行 replan 模块：根据签到结果调整项目计划。用户点击了快捷回复「根据签到调整计划」，请直接运行 replan 模块生成计划调整草案。",
    "根据成员情况推荐分工": "请执行 assign 模块：根据成员情况推荐分工。用户点击了快捷回复「根据成员情况推荐分工」，请直接运行 assign 模块。",
    "把当前阶段拆成任务": "请执行 breakdown 模块：把当前阶段拆成可执行任务。用户点击了快捷回复「把当前阶段拆成任务」，请直接运行 breakdown 模块。",
    "按三周节奏生成阶段计划": "请执行 plan 模块：按三周节奏生成阶段计划。用户点击了快捷回复「按三周节奏生成阶段计划」，请直接运行 plan 模块。",
    "先帮我澄清方向": "请执行 clarify 模块：澄清项目方向。用户点击了快捷回复「先帮我澄清方向」，请直接运行 clarify 模块。",
}


def _map_quick_reply_instruction(label: str) -> str:
    return QUICK_REPLY_INSTRUCTION_MAP.get(label, label)


def _structured_suggestions(labels: list[str]) -> list[AgentSuggestionRead]:
    suggestions: list[AgentSuggestionRead] = []
    for index, label in enumerate(labels[:3]):
        suggestions.append(
            AgentSuggestionRead(
                id=f"suggestion-{index + 1}",
                label=label,
                user_instruction=_map_quick_reply_instruction(label),
                priority="primary" if index == 0 else "secondary",
            )
        )
    return suggestions


def _artifacts_from_flow_result(session: Session, flow_result, turn_plan: AgentTurnPlan) -> list[AgentArtifactRead]:
    artifacts: list[AgentArtifactRead] = []
    if flow_result.proposal_id:
        proposal = session.get(AgentProposal, flow_result.proposal_id)
        if proposal:
            artifacts.append(_proposal_to_artifact(proposal, turn_plan))
    elif turn_plan.selected_module == "risk" and flow_result.created_ids:
        artifacts.append(
            AgentArtifactRead(
                id=f"risk-artifact-{flow_result.created_ids[0]}",
                type="risk_analysis",
                status="draft",
                title="风险分析",
                summary=f"已识别 {len(flow_result.created_ids)} 个风险信号。",
                rationale=turn_plan.rationale,
                impact=flow_result.created_ids,
                linked_entity_ids=flow_result.created_ids,
            )
        )
    elif turn_plan.selected_module == "push" and flow_result.created_ids:
        artifacts.append(
            AgentArtifactRead(
                id=f"action-artifact-{flow_result.created_ids[0]}",
                type="action_card",
                status="draft",
                title="下一步行动卡",
                summary=f"已生成 {len(flow_result.created_ids)} 张行动卡。",
                rationale=turn_plan.rationale,
                impact=flow_result.created_ids,
                linked_entity_ids=flow_result.created_ids,
            )
        )
    return artifacts


def _proposal_to_artifact(proposal: AgentProposal, turn_plan: AgentTurnPlan) -> AgentArtifactRead:
    payload = _proposal_payload(proposal)
    title = _proposal_title(proposal.proposal_type)
    proposal_status = getattr(proposal.status, "value", proposal.status)
    status = {
        "pending": "pending_confirmation",
        "confirmed": "confirmed",
        "rejected": "dismissed",
    }.get(str(proposal_status), "draft")
    return AgentArtifactRead(
        id=f"proposal-artifact-{proposal.id}",
        type="proposal",
        status=status,
        title=title,
        summary=_proposal_summary(payload, title),
        rationale=_proposal_rationale(payload, turn_plan.rationale),
        impact=_proposal_impact(payload, proposal.proposal_type),
        linked_entity_ids=[proposal.id],
    )


def _proposal_payload(proposal: AgentProposal) -> dict[str, Any]:
    if isinstance(proposal.payload, dict):
        return proposal.payload
    try:
        parsed = json.loads(proposal.payload)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {"items": parsed}


def _proposal_title(proposal_type: str) -> str:
    return {
        "clarify": "方向澄清提案",
        "plan": "阶段计划提案",
        "breakdown": "任务拆解提案",
        "replan": "计划调整草案",
    }.get(proposal_type, "Agent 提案")


def _proposal_summary(payload: dict[str, Any], fallback_title: str) -> str:
    for key in ("summary", "reason", "rationale", "impact", "problem", "goal"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    if isinstance(payload.get("stages"), list):
        return f"{fallback_title}包含 {len(payload['stages'])} 个阶段。"
    if isinstance(payload.get("tasks"), list):
        return f"{fallback_title}包含 {len(payload['tasks'])} 个任务。"
    return f"{fallback_title}已生成，等待你确认后应用。"


def _proposal_rationale(payload: dict[str, Any], fallback: str) -> str:
    for key in ("reason", "rationale", "why", "analysis"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return fallback or "Agent 根据当前项目状态生成了这条建议。"


def _proposal_impact(payload: dict[str, Any], proposal_type: str) -> list[str]:
    value = payload.get("impact")
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    if proposal_type == "replan":
        return ["可能调整任务优先级、负责人或截止时间。"]
    if proposal_type == "plan":
        return ["确认后会更新阶段计划。"]
    if proposal_type == "breakdown":
        return ["确认后会更新任务拆解。"]
    if proposal_type == "clarify":
        return ["确认后会更新方向卡。"]
    return ["确认后会同步到项目。"]


def _next_suggestions(workspace_state) -> list[str]:
    focus = _focus_for_workspace_state(workspace_state)
    return {
        "方向澄清": ["先帮我澄清方向", "根据资料生成方向卡", "为什么要先澄清方向？"],
        "阶段计划": ["按三周节奏生成阶段计划", "按答辩倒排阶段", "解释阶段规划依据"],
        "任务拆解": ["把当前阶段拆成任务", "任务拆得更细一点", "优先保留 MVP 任务"],
        "分工确认": ["根据成员情况推荐分工", "解释分工依据", "查看未确认分工"],
        "执行推进": ["生成下一步行动卡", "分析当前风险", "根据签到调整计划"],
    }.get(focus, ["下一步做什么？"])


def _answer_content(turn_plan: AgentTurnPlan, workspace_state) -> str:
    focus = _focus_for_workspace_state(workspace_state)
    if focus == "方向澄清":
        return "当前最重要的是先完成方向澄清。方向卡确认前，阶段计划、任务拆解和分工都会缺少可靠边界。"
    if focus == "阶段计划":
        return "当前应该生成并确认阶段计划。阶段计划确认后，我才能把每个阶段拆成可执行任务。"
    if focus == "任务拆解":
        return "当前应该把已确认阶段拆成任务。任务确认后，我才能继续推荐分工。"
    if focus == "分工确认":
        return "当前应该完成分工推荐和成员确认。最终分工确认后，我才能进入主动推进。"
    return turn_plan.rationale or "我会根据当前项目状态给出下一步建议。"


def _success_content(turn_plan: AgentTurnPlan, proposal_id: str | None) -> str:
    artifact = turn_plan.expected_artifact or "Agent 输出"
    if proposal_id:
        return f"{artifact}已生成，已放入待确认队列。你确认后我才会应用到项目。"
    return f"{artifact}已生成并记录到项目中。"


def _client_model(llm_client: LLMClient) -> str:
    return str(getattr(llm_client, "model", llm_client.__class__.__name__))
