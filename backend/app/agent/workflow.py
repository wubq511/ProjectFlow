import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any

from sqlmodel import Session

from app.agent.llm_client import LLMClient, LLMConnectionError, LLMError, LLMTimeoutError
from app.agent.output_schemas import AgentOutputBase, AgentOutputValidationError, validate_agent_output
from app.agent.prompts import build_prompt_messages
from app.models import AgentEvent
from app.models.enums import AgentEventStatus, AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


class AgentRunStatus(str, Enum):
    success = "success"
    repaired = "repaired"
    fallback = "fallback"
    failed = "failed"


@dataclass(frozen=True)
class AgentRunResult:
    output: AgentOutputBase
    status: AgentRunStatus
    attempts: int
    used_fallback: bool
    raw_output: str | None


def generate_structured_output(
    *,
    session: Session | None,
    workspace_state: WorkspaceStateResponse,
    event_type: AgentEventType,
    llm_client: LLMClient,
    user_prompt: str,
    fallback_payload: dict[str, Any],
) -> AgentRunResult:
    messages = build_prompt_messages(
        event_type=event_type,
        workspace_state=workspace_state,
        user_prompt=user_prompt,
    )
    last_raw: str | None = None
    last_error: Exception | None = None

    for attempt in range(1, 3):
        try:
            last_raw = llm_client.complete(messages, max_tokens=_max_tokens_for_event(event_type))
        except (LLMTimeoutError, LLMConnectionError) as exc:
            return _fallback_after_provider_error(
                session=session,
                workspace_state=workspace_state,
                event_type=event_type,
                user_prompt=user_prompt,
                fallback_payload=fallback_payload,
                attempts=attempt,
                raw_output=last_raw,
                provider_error=exc,
            )
        except LLMError as exc:
            _log_failed_agent_event(session, workspace_state, event_type, user_prompt, exc)
            raise
        try:
            payload, repaired = _parse_or_repair_json(last_raw)
            output = validate_agent_output(event_type, payload, workspace_state=workspace_state)
            status = AgentRunStatus.repaired if repaired else AgentRunStatus.success
            _log_agent_event(session, workspace_state, event_type, status, user_prompt, output)
            return AgentRunResult(
                output=output,
                status=status,
                attempts=attempt,
                used_fallback=False,
                raw_output=last_raw,
            )
        except (AgentOutputValidationError, ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "The previous response failed JSON/schema validation. "
                        f"Return exactly one valid JSON object. Error: {exc}"
                    ),
                }
            )

    try:
        output = validate_agent_output(event_type, fallback_payload, workspace_state=workspace_state)
    except AgentOutputValidationError as exc:
        _log_failed_agent_event(session, workspace_state, event_type, user_prompt, last_error or exc)
        raise

    _log_agent_event(session, workspace_state, event_type, AgentRunStatus.fallback, user_prompt, output)
    return AgentRunResult(
        output=output,
        status=AgentRunStatus.fallback,
        attempts=2,
        used_fallback=True,
        raw_output=last_raw,
    )


def _fallback_after_provider_error(
    *,
    session: Session | None,
    workspace_state: WorkspaceStateResponse,
    event_type: AgentEventType,
    user_prompt: str,
    fallback_payload: dict[str, Any],
    attempts: int,
    raw_output: str | None,
    provider_error: LLMError,
) -> AgentRunResult:
    try:
        output = validate_agent_output(event_type, fallback_payload, workspace_state=workspace_state)
    except AgentOutputValidationError as exc:
        _log_failed_agent_event(session, workspace_state, event_type, user_prompt, provider_error)
        raise exc from provider_error

    _log_agent_event(
        session,
        workspace_state,
        event_type,
        AgentRunStatus.fallback,
        user_prompt,
        output,
        provider_error=provider_error,
    )
    return AgentRunResult(
        output=output,
        status=AgentRunStatus.fallback,
        attempts=attempts,
        used_fallback=True,
        raw_output=raw_output,
    )


def _max_tokens_for_event(event_type: AgentEventType) -> int:
    """Return max_tokens for the given event type.

    Reasoning models (e.g. DeepSeek) consume a large portion of completion
    tokens for internal thought before producing visible output, so these
    values are deliberately generous.  Non-reasoning models will stop far
    earlier — the cap only limits the upper bound.
    """
    return {
        AgentEventType.clarify: 3000,
        AgentEventType.plan: 4000,
        AgentEventType.breakdown: 4000,
        AgentEventType.assign: 3000,
        AgentEventType.negotiate: 2000,
        AgentEventType.push: 3000,
        AgentEventType.checkin: 4000,
        AgentEventType.risk: 3000,
        AgentEventType.replan: 4000,
    }[event_type]


def _parse_or_repair_json(raw: str) -> tuple[dict[str, Any], bool]:
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("agent output must be a JSON object")
        return payload, False
    except json.JSONDecodeError:
        repaired_text = _repair_json_text(raw)
        payload = json.loads(repaired_text)
        if not isinstance(payload, dict):
            raise ValueError("agent output must be a JSON object")
        return payload, True


def _repair_json_text(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last >= first:
        text = text[first:last + 1]
    text = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        json.loads(text)
        return text
    except json.JSONDecodeError:
        pass
    replaced = text.replace("'", '"')
    try:
        json.loads(replaced)
        return replaced
    except json.JSONDecodeError:
        pass
    text = re.sub(r"'([^']*)'(\s*:)", r'"\1"\2', text)
    text = re.sub(r":\s*'([^']*)'", r': "\1"', text)
    return text


def _log_agent_event(
    session: Session | None,
    workspace_state: WorkspaceStateResponse,
    event_type: AgentEventType,
    status: AgentRunStatus,
    user_prompt: str,
    output: AgentOutputBase,
    provider_error: LLMError | None = None,
) -> None:
    if session is None:
        return
    input_snapshot = {
        "event_type": event_type.value,
        "user_prompt": user_prompt,
        "workspace_state": workspace_state.model_dump(mode="json"),
    }
    if provider_error is not None:
        input_snapshot["provider_error"] = {
            "type": provider_error.__class__.__name__,
            "message": str(provider_error),
            "detail": provider_error.detail,
        }
    event = AgentEvent(
        project_id=workspace_state.project.id if workspace_state.project else "",
        workspace_id=workspace_state.workspace_id,
        event_type=event_type,
        status=AgentEventStatus(status.value),
        input_snapshot=json.dumps(input_snapshot, ensure_ascii=False),
        output_snapshot=json.dumps(output.model_dump(mode="json"), ensure_ascii=False),
        reasoning_summary=output.reason,
    )
    session.add(event)
    session.flush()


def _log_failed_agent_event(
    session: Session | None,
    workspace_state: WorkspaceStateResponse,
    event_type: AgentEventType,
    user_prompt: str,
    error: Exception,
) -> None:
    if session is None:
        return
    event = AgentEvent(
        project_id=workspace_state.project.id if workspace_state.project else "",
        workspace_id=workspace_state.workspace_id,
        event_type=event_type,
        status=AgentEventStatus.failed,
        input_snapshot=json.dumps({
            "event_type": event_type.value,
            "user_prompt": user_prompt,
            "workspace_state": workspace_state.model_dump(mode="json"),
        }, ensure_ascii=False),
        output_snapshot=json.dumps({"error": str(error)}, ensure_ascii=False),
        reasoning_summary=str(error),
    )
    session.add(event)
    session.flush()
