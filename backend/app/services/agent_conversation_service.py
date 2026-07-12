"""
Agent conversation service — sidecar proxy mode.

The conversation stream endpoint proxies to the sidecar Pi runtime,
which handles LLM inference, tool execution, and policy gating.
Message persistence (user + assistant) remains in this service.
"""

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any, Iterator

import httpx
from pydantic import ValidationError
from sqlmodel import Session, desc, select

from app.core.config import settings
from app.models import Project
from app.models.agent_conversation import AgentConversation, AgentMessage
from app.schemas.agent_conversation import (
    AgentConversationRead,
    AgentConversationTurnRead,
    AgentMessageRead,
    AgentSuggestionRead,
    StreamContentEventSchema,
    StreamDonePayloadSchema,
    StreamErrorEventSchema,
    StreamStatusEventSchema,
    StreamToolEventSchema,
)
from app.services.workspace_state_service import get_workspace_state


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# SSE helper
# ---------------------------------------------------------------------------

def _sse_event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ---------------------------------------------------------------------------
# Conversation CRUD
# ---------------------------------------------------------------------------

def get_or_create_project_conversation(
    session: Session,
    project_id: str,
) -> AgentConversation:
    """Get or create an AgentConversation for a project."""
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
        project_id=project_id,
        status="active",
    )
    session.add(conversation)
    session.commit()
    session.refresh(conversation)
    return conversation


def read_project_conversation(session: Session, project_id: str) -> AgentConversationRead:
    conversation = get_or_create_project_conversation(session, project_id)
    return _conversation_to_read(session, conversation)


# ---------------------------------------------------------------------------
# Legacy non-stream endpoint — deprecated (410 Gone)
# ---------------------------------------------------------------------------

def process_conversation_message(
    session: Session,
    conversation_id: str,
    content: str,
    *,
    viewer_user_id: str | None = None,
) -> AgentConversationTurnRead:
    """Deprecated — use the stream endpoint instead."""
    raise ValueError("非流式对话端点已废弃，请使用流式端点。")


# ---------------------------------------------------------------------------
# Stream endpoint — sidecar proxy
# ---------------------------------------------------------------------------

def process_conversation_message_stream(
    session: Session,
    conversation_id: str,
    content: str,
    *,
    viewer_user_id: str | None = None,
) -> Iterator[str]:
    """Yield SSE events by proxying to the sidecar Pi runtime."""
    conversation = session.get(AgentConversation, conversation_id)
    if conversation is None:
        yield _sse_event("error", {"message": "对话不存在"})
        return
    project = session.get(Project, conversation.project_id)
    if project is None:
        yield _sse_event("error", {"message": "项目不存在"})
        return

    # 1. Save user message
    user_message = AgentMessage(
        conversation_id=conversation.id,
        role="user",
        content=content,
    )
    session.add(user_message)
    session.commit()
    session.refresh(user_message)

    # 2. Build context for sidecar
    workspace_state = get_workspace_state(
        session,
        conversation.workspace_id,
        project_id=conversation.project_id,
    )
    recent_messages = _recent_messages(session, conversation.id)

    # Map deterministic intent to sidecar Skill name.
    # Only unambiguous action intents get a skill; general questions stay in answer mode.
    skill_name = _extract_skill_name(content)

    sidecar_request = {
        "conversation_id": conversation.id,
        "workspace_id": conversation.workspace_id,
        "project_id": conversation.project_id,
        "user_content": content,
        "viewer_user_id": viewer_user_id,
        "workspace_state": workspace_state.model_dump(mode="json") if workspace_state else None,
        "recent_messages": json.loads(_messages_json(recent_messages)) if recent_messages else [],
        "runtime_config": {
            "max_steps": 10,
            "max_tool_calls": 20,
            **({"skill": skill_name} if skill_name else {}),
        },
    }

    # 3. Call sidecar /runs/stream and proxy SSE events
    sidecar_url = f"{settings.sidecar_base_url}/runs/stream"
    accumulated_content = ""

    try:
        with httpx.stream(
            "POST",
            sidecar_url,
            json=sidecar_request,
            timeout=httpx.Timeout(120.0, connect=5.0),
        ) as sidecar_resp:
            if sidecar_resp.status_code != 200:
                error_body = sidecar_resp.read().decode("utf-8", errors="replace")[:500]
                logger.error(
                    "Sidecar stream failed: status=%d body_length=%d",
                    sidecar_resp.status_code,
                    len(error_body),
                )
                # Always use fixed Chinese messages — never forward sidecar detail/error to frontend
                if sidecar_resp.status_code == 400:
                    yield _sse_event("error", {"message": "请求参数无效，请检查输入。"})
                elif sidecar_resp.status_code == 401:
                    yield _sse_event("error", {"message": "Agent 服务认证失败。"})
                elif sidecar_resp.status_code == 429:
                    yield _sse_event("error", {"message": "Agent 服务请求过频，请稍后重试。"})
                else:
                    yield _sse_event("error", {"message": "Agent 服务暂时不可用，请稍后重试。"})
                return

            # Parse SSE from sidecar and map to frontend events
            buffer = ""
            current_event = ""
            received_terminal = False  # Track whether we got done/error
            for chunk in sidecar_resp.iter_text():
                buffer += chunk
                lines = buffer.split("\n")
                buffer = lines.pop()  # keep incomplete line

                for line in lines:
                    line = line.strip()
                    if not line:
                        current_event = ""
                        continue
                    if line.startswith("event: "):
                        current_event = line[7:].strip()
                    elif line.startswith("data: "):
                        data_str = line[6:]
                        try:
                            data = json.loads(data_str)
                        except json.JSONDecodeError:
                            logger.warning("Malformed SSE data from sidecar: event=%s length=%d", current_event or "unknown", len(data_str))
                            continue

                        # Map sidecar events to frontend events
                        if current_event == "status":
                            try:
                                validated_status = StreamStatusEventSchema.model_validate(data)
                                yield _sse_event("status", validated_status.model_dump(mode="json"))
                            except ValidationError as exc:
                                logger.warning(
                                    "Invalid status event (skipped): len=%d err=%s",
                                    len(data_str),
                                    type(exc).__name__,
                                )
                        elif current_event == "content":
                            # Typed streaming contract: validate with Pydantic, then proxy to frontend.
                            try:
                                validated = StreamContentEventSchema.model_validate(data)
                                # Only accumulate text_delta content for final_content fallback.
                                if validated.kind == "text" and validated.phase == "delta":
                                    accumulated_content += validated.content or ""
                                yield _sse_event("content", validated.model_dump(mode="json"))
                            except ValidationError as exc:
                                _safe_data = data if isinstance(data, dict) else {}
                                logger.warning("Invalid content event (skipped): kind=%s phase=%s len=%d err=%s", _safe_data.get("kind"), _safe_data.get("phase"), len(data_str), type(exc).__name__)
                        elif current_event == "tool":
                            # Typed tool lifecycle event: validate with Pydantic, then proxy.
                            try:
                                validated = StreamToolEventSchema.model_validate(data)
                                yield _sse_event("tool", validated.model_dump(mode="json"))
                            except ValidationError as exc:
                                _safe_data = data if isinstance(data, dict) else {}
                                logger.warning("Invalid tool event (skipped): phase=%s len=%d err=%s", _safe_data.get("phase"), len(data_str), type(exc).__name__)
                        elif current_event == "token":
                            # The repository is deployed atomically. Untyped legacy tokens are
                            # deliberately ignored so they cannot bypass the typed content contract.
                            logger.warning("Legacy token event ignored: len=%d", len(data_str))
                        elif current_event == "done":
                            received_terminal = True
                            # Validate done payload with Pydantic before persisting.
                            # Fallback: if validation fails, use accumulated_content as final_content
                            # and empty execution_steps/thinking_content.
                            try:
                                done_payload = StreamDonePayloadSchema.model_validate(data)
                                final_content = (
                                    done_payload.final_content
                                    if done_payload.final_content.strip()
                                    else accumulated_content
                                )
                                execution_steps = [s.model_dump() for s in done_payload.execution_steps]
                                thinking_content = done_payload.thinking_content
                            except ValidationError as exc:
                                logger.warning("Invalid done payload (using safe fallback): len=%d err=%s", len(data_str), type(exc).__name__)
                                # SAFE FALLBACK: never persist unvalidated fields.
                                # Only use accumulated_content (from validated text_delta events).
                                final_content = accumulated_content
                                execution_steps = []
                                thinking_content = ""
                            # If there's no answer content at all, return error instead of saving empty message
                            if not final_content.strip():
                                yield _sse_event("error", {"message": "Agent 未生成有效回答，请重试。"})
                                return
                            # 4. Save assistant message
                            assistant_message = _save_assistant_message(
                                session, conversation, final_content,
                                execution_steps=execution_steps,
                                thinking_content=thinking_content,
                            )
                            # 5. Build and yield done event
                            turn = _build_done_turn(
                                session, conversation, user_message, assistant_message,
                            )
                            yield _sse_event("done", turn.model_dump(mode="json"))
                            return
                        elif current_event == "error":
                            received_terminal = True
                            try:
                                validated_error = StreamErrorEventSchema.model_validate(data)
                                yield _sse_event("error", validated_error.model_dump(mode="json"))
                            except ValidationError as exc:
                                logger.warning(
                                    "Invalid error event (using safe fallback): len=%d err=%s",
                                    len(data_str),
                                    type(exc).__name__,
                                )
                                yield _sse_event("error", {"message": "Agent 处理失败，请稍后重试。"})
                            return

                        current_event = ""

            # SSE terminal guard: if the stream ended without done/error,
            # the frontend would be stuck in loading forever.
            if not received_terminal:
                logger.warning("Sidecar SSE stream ended without terminal event")
                yield _sse_event("disconnect", {"reason": "连接意外中断，可重试"})

    except httpx.ConnectError:
        logger.error("Cannot reach sidecar at %s", sidecar_url)
        # Use deterministic intent matcher to provide actionable guidance
        intent = _deterministic_intent_match(content)
        if intent:
            guidance = (
                f"我理解你想「{intent}」，但 Agent 服务当前未启动。"
                "请确认 sidecar 已启动（端口 4000），然后重试。"
            )
        else:
            guidance = "Agent 服务未启动，请确认 sidecar 已启动（端口 4000）。"
        # Persist assistant message so the response survives page refresh
        assistant_message = _save_assistant_message(session, conversation, guidance)
        session.refresh(user_message)
        # Stream the guidance as typed content events (not legacy token events)
        yield _sse_event("status", {"phase": "answering", "message": "正在生成回复..."})
        yield _sse_event("content", {"kind": "text", "phase": "start", "content_index": 0, "message_seq": 1})
        yield _sse_event("content", {"kind": "text", "phase": "delta", "content_index": 0, "message_seq": 1, "content": guidance})
        yield _sse_event("content", {"kind": "text", "phase": "end", "content_index": 0, "message_seq": 1})
        turn = _build_done_turn(session, conversation, user_message, assistant_message)
        yield _sse_event("done", turn.model_dump(mode="json"))
        return
    except httpx.TimeoutException:
        logger.error("Sidecar stream timed out")
        yield _sse_event("error", {"message": "Agent 响应超时，请稍后重试。"})
    except (httpx.ReadError, httpx.RemoteProtocolError) as exc:
        logger.error("Sidecar stream disconnected: %s", exc)
        yield _sse_event("disconnect", {"reason": "连接意外中断，可重试"})
    except Exception:
        logger.exception("Sidecar stream proxy failed")
        yield _sse_event("error", {"message": "Agent 处理失败，请稍后重试。"})


# ---------------------------------------------------------------------------
# Message persistence helpers
# ---------------------------------------------------------------------------

def _save_assistant_message(
    session: Session,
    conversation: AgentConversation,
    content: str,
    *,
    execution_steps: list[dict[str, Any]] | None = None,
    thinking_content: str | None = None,
) -> AgentMessage:
    """Save assistant message and update conversation."""
    next_labels = _next_suggestions_from_conversation(session, conversation)
    suggestions = _structured_suggestions(next_labels)

    assistant_message = AgentMessage(
        conversation_id=conversation.id,
        role="assistant",
        content=content,
    )
    payload: dict[str, Any] = {
        "next_suggestions": next_labels,
        "suggestions": [s.model_dump(mode="json") for s in suggestions],
    }
    if execution_steps:
        payload["execution_steps"] = execution_steps
    if thinking_content:
        payload["thinking_content"] = thinking_content
    assistant_message.set_structured_payload(payload)
    session.add(assistant_message)

    conversation.updated_at = datetime.now(UTC)
    session.add(conversation)
    session.commit()
    session.refresh(assistant_message)
    return assistant_message


def _build_done_turn(
    session: Session,
    conversation: AgentConversation,
    user_message: AgentMessage,
    assistant_message: AgentMessage,
) -> AgentConversationTurnRead:
    """Build the done event payload."""
    session.refresh(conversation)
    payload = assistant_message.get_structured_payload()
    next_labels = payload.get("next_suggestions", [])
    suggestions_data = payload.get("suggestions", [])
    suggestions = [AgentSuggestionRead(**s) for s in suggestions_data] if suggestions_data else _structured_suggestions(next_labels)

    return AgentConversationTurnRead(
        conversation=_conversation_to_read(session, conversation),
        user_message=_message_to_read(user_message),
        assistant_message=_message_to_read(assistant_message),
        run=None,
        turn_plan=None,
        next_suggestions=next_labels,
        suggestions=suggestions,
        artifacts=[],
    )


# ---------------------------------------------------------------------------
# Internal helpers (preserved from legacy)
# ---------------------------------------------------------------------------

def _conversation_to_read(session: Session, conversation: AgentConversation) -> AgentConversationRead:
    messages = session.exec(
        select(AgentMessage)
        .where(AgentMessage.conversation_id == conversation.id)
        .order_by(AgentMessage.created_at)
        .limit(200)
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


def _next_suggestions(workspace_state) -> list[str]:
    focus = _focus_for_workspace_state(workspace_state)
    return {
        "方向澄清": ["先帮我澄清方向", "根据资料生成方向卡", "为什么要先澄清方向？"],
        "阶段计划": ["按三周节奏生成阶段计划", "按答辩倒排阶段", "解释阶段规划依据"],
        "任务拆解": ["把当前阶段拆成任务", "任务拆得更细一点", "优先保留 MVP 任务"],
        "分工确认": ["根据成员情况推荐分工", "解释分工依据", "查看未确认分工"],
        "执行推进": ["生成下一步行动卡", "分析当前风险", "根据签到调整计划"],
    }.get(focus, ["下一步做什么？"])


def _next_suggestions_from_conversation(session: Session, conversation: AgentConversation) -> list[str]:
    """Get next suggestions based on current workspace state."""
    workspace_state = get_workspace_state(
        session,
        conversation.workspace_id,
        project_id=conversation.project_id,
    )
    if workspace_state:
        return _next_suggestions(workspace_state)
    return ["下一步做什么？"]


# ---------------------------------------------------------------------------
# Deterministic intent matcher (sidecar-unavailable fallback)
# ---------------------------------------------------------------------------

# Ordered by specificity — more specific patterns should match first.
# These are BROAD patterns used only for the sidecar-unavailable guidance
# message, NOT for Skill selection.
_INTENT_PATTERNS: list[tuple[str, str]] = [
    ("方向澄清", r"澄清方向|方向澄清|帮我澄清|先认证|先澄清"),
    ("生成阶段计划", r"阶段计划|生成.*计划|制定.*计划|规划.*阶段|阶段.*规划|时间表|里程碑|plan\b"),
    ("任务拆解", r"拆成任务|任务拆解|拆解.*任务|把.*拆|分解.*任务|breakdown\b"),
    ("推荐分工", r"分工|分配.*成员|推荐.*分工|assign\b"),
    ("生成行动卡", r"行动卡|生成.*行动|下一步.*行动|push\b"),
    ("分析风险", r"分析.*风险|风险.*分析|risk\b|阻塞|延期"),
    ("签到分析", r"签到|检查.*进度|checkin\b"),
    ("调整计划", r"调整计划|重新规划|重排|replan\b"),
]


def _deterministic_intent_match(content: str) -> str | None:
    """Match user message to an intent label using keyword patterns.

    Returns a human-readable intent label on match, or None.
    Used as fallback when the sidecar is unavailable.
    """
    lowered = content.lower()
    for label, pattern in _INTENT_PATTERNS:
        if re.search(pattern, lowered):
            return label
    return None


# ---------------------------------------------------------------------------
# Narrow action-to-Skill matcher (sidecar skill resolution)
# ---------------------------------------------------------------------------

# Precedence rules for _extract_skill_name:
# 1. Exact quick-reply phrases → action Skill (deterministic product contract)
# 2. Explicit request markers (请/帮我/麻烦/请执行/直接/开始) + action object → action
# 3. Question/explanation-only markers → answer mode (None)
# 4. Narrow imperative action patterns → action Skill
# Bare domain words (风险/延期/阻塞/签到/分工/阶段计划/方向澄清) alone → answer mode.

# Question/explanation markers — used only when NO explicit request marker is present.
_QUESTION_ONLY_MARKERS = re.compile(
    r"什么|为什么|如何|哪[些]?|怎么|是否|什么意思|是什么|怎么样|对不对"
)

# Explicit request markers that override question syntax.
# "可以帮我制定计划吗？" has 吗 but also 帮我 → action.
_REQUEST_MARKERS = re.compile(r"请|帮我|麻烦|请执行|直接|开始")

# Bare feature/domain labels are ambiguous: they can be navigation labels or
# requests for explanation. Without an explicit request marker, keep them in
# answer mode instead of allowing an advisory/proposal write.
_AMBIGUOUS_BARE_LABELS = {
    "方向澄清",
    "阶段计划",
    "任务拆解",
    "推荐分工",
    "风险分析",
    "签到分析",
}

# Exact quick-reply phrases from QUICK_REPLY_INSTRUCTION_MAP.
# These are deterministic product contracts and always map to action Skills.
_EXACT_QUICK_REPLIES: list[tuple[str, str]] = [
    ("project-status", r"^生成下一步行动卡$"),
    ("risk-analysis", r"^分析当前风险$"),
    ("risk-replan", r"^根据签到调整计划$"),
    ("assignment-planning", r"^根据成员情况推荐分工$"),
    ("task-breakdown", r"^把当前阶段拆成任务$"),
    ("project-planning", r"^按三周节奏生成阶段计划$"),
    ("project-intake", r"^先帮我澄清方向$"),
]

# Expanded quick-reply instructions (the full text sent after mapping).
_EXPANDED_QUICK_REPLIES: list[tuple[str, str]] = [
    ("risk-analysis", r"请执行 risk 模块"),
    ("risk-replan", r"请执行 replan 模块"),
    ("assignment-planning", r"请执行 assign 模块"),
    ("task-breakdown", r"请执行 breakdown 模块"),
    ("project-planning", r"请执行 plan 模块"),
    ("project-intake", r"请执行 clarify 模块"),
    ("project-status", r"请执行 push 模块"),
]

# Action-verb+domain-object patterns (narrow, imperative).
# Only matched when preceded by an explicit request marker OR when no
# question markers are present.
_IMPERATIVE_ACTION_PATTERNS: list[tuple[str, str]] = [
    # Clarification
    ("project-intake", r"澄清.*方向|方向澄清"),
    # Planning
    ("project-planning", r"制定.*计划|生成.*计划|规划.*阶段|阶段.*规划|制定规划"),
    # Breakdown
    ("task-breakdown", r"拆成任务|任务拆解|拆解.*任务|分解.*任务|拆成.*任务"),
    # Assignment
    ("assignment-planning", r"推荐.*分工|分配.*成员|分配一下.*成员"),
    # Status/Push
    ("project-status", r"生成.*行动卡|下一步.*行动"),
    # Risk analysis — explicit analysis action
    ("risk-analysis", r"分析.*风险|风险.*分析|检查.*风险|识别.*风险"),
    # Replan
    ("risk-replan", r"调整计划|重新规划|重排.*计划|根据.*签到.*调整"),
]


def _extract_skill_name(content: str) -> str | None:
    """Extract a sidecar Skill name from user content.

    Precedence:
    1. Exact quick-reply phrases → action Skill
    2. Expanded quick-reply instructions → action Skill
    3. Explicit request marker + action object → action Skill
    4. Question-only markers (without request marker) → answer mode
    5. Narrow imperative patterns (no question markers) → action Skill
    6. Otherwise → answer mode (None)

    Only used for the conversation streaming path; dashboard buttons pass
    runtime_config.skill explicitly.
    """
    # 1. Exact quick-reply phrases (deterministic product contract)
    for skill_name, pattern in _EXACT_QUICK_REPLIES:
        if re.search(pattern, content):
            return skill_name

    # 2. Expanded quick-reply instructions
    for skill_name, pattern in _EXPANDED_QUICK_REPLIES:
        if re.search(pattern, content):
            return skill_name

    # 3. Explicit request markers override question syntax
    has_request_marker = bool(_REQUEST_MARKERS.search(content))
    has_question_marker = bool(_QUESTION_ONLY_MARKERS.search(content))
    normalized_content = content.strip().rstrip("？?").strip()

    if has_request_marker:
        # "可以帮我制定计划吗？" → action despite 吗
        for skill_name, pattern in _IMPERATIVE_ACTION_PATTERNS:
            if re.search(pattern, content):
                return skill_name
        # Request marker but no matching action object → fall through

    # 4. Question-only markers without request marker → answer mode
    if has_question_marker and not has_request_marker:
        return None

    if not has_request_marker and normalized_content in _AMBIGUOUS_BARE_LABELS:
        return None

    # 5. Narrow imperative patterns (no question markers present)
    for skill_name, pattern in _IMPERATIVE_ACTION_PATTERNS:
        if re.search(pattern, content):
            return skill_name

    # 6. No match → answer mode
    return None
