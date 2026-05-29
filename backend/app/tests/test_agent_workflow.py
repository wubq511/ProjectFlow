from datetime import date

import json
import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent.llm_client import (
    LLMAuthError,
    LLMClientSettings,
    LLMConfigurationError,
    MockLLMClient,
    OpenAICompatibleLLMClient,
    build_llm_client,
)
from app.agent.prompts import AGENT_SYSTEM_PROMPT
from app.agent.workflow import AgentRunStatus, generate_structured_output
from app.models import AgentEvent
from app.models.enums import AgentEventStatus, AgentEventType
from app.schemas.workspace_state import ProjectState, WorkspaceStateResponse


def _parse_snapshot(raw: str) -> dict:
    """Helper: AgentEvent snapshots are stored as JSON strings."""
    return json.loads(raw)


def _workspace_state() -> WorkspaceStateResponse:
    return WorkspaceStateResponse(
        workspace_id="workspace-1",
        workspace_name="Demo Team",
        members=[],
        project=ProjectState(
            id="project-1",
            name="Demo Project",
            idea="Build a project agent",
            deadline=date(2026, 6, 7),
            status="active",
            current_stage_id=None,
            stages=[],
            tasks=[],
        ),
    )


@pytest.fixture(name="session")
def session_fixture():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def _clarify_payload(reason: str = "The team needs one clear question.") -> dict:
    return {
        "summary": "Scope needs clarification.",
        "target_outcome": "Confirm the demo path.",
        "constraints": ["Deadline is fixed"],
        "suggested_questions": ["Which path must be demo-ready?"],
        "reason": reason,
    }


def test_build_llm_client_supports_mock_and_openai_compatible_settings():
    mock_client = build_llm_client(LLMClientSettings(provider="mock"))
    assert isinstance(mock_client, MockLLMClient)

    openai_client = build_llm_client(
        LLMClientSettings(
            provider="openai",
            api_key="test-key",
            base_url="https://example.test/v1",
            model="demo-model",
        )
    )
    assert isinstance(openai_client, OpenAICompatibleLLMClient)
    assert openai_client.base_url == "https://example.test/v1"
    assert openai_client.model == "demo-model"


def test_openai_compatible_client_requires_api_key():
    with pytest.raises(LLMAuthError):
        build_llm_client(LLMClientSettings(provider="openai", api_key=None))


def test_prompt_boundary_prevents_fabricated_entities():
    prompt = AGENT_SYSTEM_PROMPT.lower()

    assert "do not fabricate" in prompt
    assert "members" in prompt
    assert "tasks" in prompt
    assert "stages" in prompt
    assert "assignments" in prompt


def test_generate_structured_output_repairs_json_and_logs_event(session: Session):
    client = MockLLMClient(
        responses=[
            "```json\n"
            "{'summary':'Scope needs clarification.',"
            "'target_outcome':'Confirm the demo path.',"
            "'constraints':['Deadline is fixed'],"
            "'suggested_questions':['Which path must be demo-ready?'],"
            "'reason':'The team needs one clear question.',}\n"
            "```"
        ]
    )

    result = generate_structured_output(
        session=session,
        workspace_state=_workspace_state(),
        event_type=AgentEventType.clarify,
        llm_client=client,
        user_prompt="Create a direction card.",
        fallback_payload=_clarify_payload("Fallback should not be used."),
    )

    assert result.status == AgentRunStatus.repaired
    assert result.attempts == 1
    assert result.output.reason == "The team needs one clear question."

    event = session.exec(select(AgentEvent)).one()
    assert event.event_type == AgentEventType.clarify
    assert event.status == AgentEventStatus.repaired
    assert _parse_snapshot(event.input_snapshot)["event_type"] == "clarify"
    assert _parse_snapshot(event.output_snapshot)["reason"] == "The team needs one clear question."
    assert event.reasoning_summary == "The team needs one clear question."


def test_generate_structured_output_retries_once_then_succeeds(session: Session):
    client = MockLLMClient(
        responses=[
            "not json",
            '{"summary":"Retry worked","target_outcome":"Confirm scope",'
            '"constraints":[],"suggested_questions":["Proceed?"],'
            '"reason":"The retry returned valid JSON."}',
        ]
    )

    result = generate_structured_output(
        session=session,
        workspace_state=_workspace_state(),
        event_type=AgentEventType.clarify,
        llm_client=client,
        user_prompt="Create a direction card.",
        fallback_payload=_clarify_payload("Fallback should not be used."),
    )

    assert result.status == AgentRunStatus.success
    assert result.attempts == 2
    assert client.calls == 2

    event = session.exec(select(AgentEvent)).one()
    assert event.status == AgentEventStatus.success


def test_generate_structured_output_uses_template_fallback_after_retry(session: Session):
    client = MockLLMClient(responses=["not json", '{"summary":"missing fields"}'])

    result = generate_structured_output(
        session=session,
        workspace_state=_workspace_state(),
        event_type=AgentEventType.clarify,
        llm_client=client,
        user_prompt="Create a direction card.",
        fallback_payload=_clarify_payload("Fallback gives a safe proposal."),
    )

    assert result.status == AgentRunStatus.fallback
    assert result.attempts == 2
    assert result.used_fallback is True
    assert result.output.reason == "Fallback gives a safe proposal."

    event = session.exec(select(AgentEvent)).one()
    assert event.status == AgentEventStatus.fallback
    assert _parse_snapshot(event.output_snapshot)["reason"] == "Fallback gives a safe proposal."
