import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any

from sqlmodel import Session

from app.agent.llm_client import LLMClient
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
        last_raw = llm_client.complete(messages)
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
    text = text.replace("'", '"')
    text = re.sub(r",\s*([}\]])", r"\1", text)
    return text


def _log_agent_event(
    session: Session | None,
    workspace_state: WorkspaceStateResponse,
    event_type: AgentEventType,
    status: AgentRunStatus,
    user_prompt: str,
    output: AgentOutputBase,
) -> None:
    if session is None:
        return
    event = AgentEvent(
        project_id=workspace_state.project.id if workspace_state.project else "",
        workspace_id=workspace_state.workspace_id,
        event_type=event_type,
        status=AgentEventStatus(status.value),
        input_snapshot={
            "event_type": event_type.value,
            "user_prompt": user_prompt,
            "workspace_state": workspace_state.model_dump(mode="json"),
        },
        output_snapshot=output.model_dump(mode="json"),
        reasoning_summary=output.reason,
    )
    session.add(event)
    session.commit()


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
        input_snapshot={
            "event_type": event_type.value,
            "user_prompt": user_prompt,
            "workspace_state": workspace_state.model_dump(mode="json"),
        },
        output_snapshot={"error": str(error)},
        reasoning_summary=str(error),
    )
    session.add(event)
    session.commit()
