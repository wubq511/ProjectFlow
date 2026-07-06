"""Tests for ProjectMemory default retrieval and Agent context injection (Issue #75).

Covers acceptance criteria:
- FTS5 retrieval returns candidate memory IDs
- Structured field fallback and memory_backend=none on total failure
- Candidates are reloaded from ProjectMemory and filtered
- can_view_memory logic is reused for retrieval/export/injection
- viewer_user_id validation (400/404)
- Token budget and hard memory count truncation
- AgentEvent output_snapshot records memory metadata
- AgentRunState.side_effects does not record memory usage
- Sidecar receives memory only through FastAPI-built context
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.agent.memory.context_builder import MemoryContext, build_memory_context
from app.agent.memory.extractor import ProjectMemoryCandidate
from app.agent.memory.retriever import MemoryBackend, MemoryRetriever, retrieve_memory_ids
from app.core.database import get_session
from app.main import app
from app.models import ProjectMemory
from app.services.memory_service import (
    EXTRACTOR_VERSION,
    _write_candidates,
    set_memory_engine,
)


@pytest.fixture(name="engine")
def engine_fixture():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)
    set_memory_engine(engine)
    yield engine
    from app.core.database import engine as default_engine
    set_memory_engine(default_engine)


@pytest.fixture(name="session")
def session_fixture(engine):
    with Session(engine) as session:
        yield session


@pytest.fixture(name="client")
def client_fixture(engine):
    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _create_fixture(client: TestClient):
    """Create workspace, project, owner, member, outsider for testing."""
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Member"}).json()
    outsider = client.post("/api/users", json={"display_name": "Outsider"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Memory WS"},
        params={"owner_user_id": owner["id"]},
    ).json()
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": member["id"], "role": "member"},
    )
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Memory Project",
            "idea": "Test memory retrieval",
            "deadline": "2026-07-15",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    return workspace, project, owner, member, outsider


def _write_memory(
    session: Session,
    workspace_id: str,
    project_id: str,
    content: str,
    rationale: str = "",
    memory_type: str = "direction",
    visibility: str = "team",
    subject_user_id: str | None = None,
    owner_user_id_snapshot: str | None = None,
    valid_until: datetime | None = None,
    source_id: str | None = None,
) -> ProjectMemory:
    """Directly write a ProjectMemory row and index it."""
    candidate = ProjectMemoryCandidate(
        memory_type=memory_type,
        scope="project" if memory_type != "member_constraint" else "member",
        content=content,
        rationale=rationale or "测试理由",
        source_type="direction_card_confirmed",
        source_id=source_id or str(uuid.uuid4()),
        source_hash="test-hash-" + str(uuid.uuid4()),
        visibility=visibility,
        subject_user_id=subject_user_id,
        owner_user_id_snapshot=owner_user_id_snapshot,
        valid_until=valid_until,
    )
    written = _write_candidates(
        session,
        workspace_id=workspace_id,
        project_id=project_id,
        candidates=[candidate],
        extractor_version=EXTRACTOR_VERSION,
    )
    session.commit()
    return written[0]


# ─── Retrieval backend tests ─────────────────────────────────────────────────


def test_retrieve_memory_ids_uses_fts5(session: Session, client: TestClient):
    """FTS5 retrieval returns candidate IDs for visible active memories."""
    workspace, project, owner, *_ = _create_fixture(client)
    memory = _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="项目的核心方向是构建任务协作闭环",
        rationale="方向卡确认时确定",
    )

    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="核心方向",
        viewer_user_id=owner["id"],
    )

    assert result.backend == MemoryBackend.fts5
    assert memory.id in result.memory_ids
    assert result.retrieval_count >= 1
    assert result.latency_ms >= 0


def test_retrieve_memory_ids_returns_ids_not_text(session: Session, client: TestClient):
    """Retrieval returns memory IDs, not injectable prompt text."""
    workspace, project, owner, *_ = _create_fixture(client)
    memory = _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="MVP 边界不包含第三方登录",
        rationale="范围边界确认",
        memory_type="boundary",
    )

    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="MVP 边界",
        viewer_user_id=owner["id"],
    )

    assert all(isinstance(mid, str) for mid in result.memory_ids)
    assert memory.content not in result.memory_ids


def test_retrieve_falls_back_to_sqlite_field(session: Session, client: TestClient):
    """When FTS5 is unavailable, retrieval falls back to structured field filtering."""
    workspace, project, owner, *_ = _create_fixture(client)
    _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="阶段目标是在七月前完成后端 API",
        rationale="阶段计划确认",
        memory_type="plan",
    )

    with patch.object(MemoryRetriever, "_ensure_table", return_value=False):
        result = retrieve_memory_ids(
            session,
            project_id=project["id"],
            query="后端 API",
            viewer_user_id=owner["id"],
        )

    assert result.backend == MemoryBackend.sqlite_field
    assert result.retrieval_count >= 1


def test_retrieve_uses_none_backend_when_all_fails(session: Session, client: TestClient):
    """When query is empty and no fallback matches, backend is none."""
    workspace, project, owner, *_ = _create_fixture(client)

    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="",
        viewer_user_id=owner["id"],
    )

    assert result.backend == MemoryBackend.none
    assert result.memory_ids == []


# ─── Filtering tests ─────────────────────────────────────────────────────────


def test_retrieve_filters_stale_memories(session: Session, client: TestClient):
    """Memories past valid_until are not returned."""
    workspace, project, owner, *_ = _create_fixture(client)
    _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="已过期方向",
        rationale="曾经的方向",
        valid_until=datetime.now(UTC) - timedelta(days=1),
    )

    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="方向",
        viewer_user_id=owner["id"],
    )

    assert result.retrieval_count == 0


def test_retrieve_filters_invisible_memories(session: Session, client: TestClient):
    """subject_and_owner memory is invisible to non-subject/non-owner viewers."""
    workspace, project, owner, member, outsider = _create_fixture(client)
    _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="成员约束：小王只能晚上工作",
        rationale="分工确认时捕获",
        memory_type="member_constraint",
        visibility="subject_and_owner",
        subject_user_id=member["id"],
        owner_user_id_snapshot=owner["id"],
    )

    # Outsider is not a workspace member, so validate_viewer raises
    with pytest.raises(ValueError):
        retrieve_memory_ids(
            session,
            project_id=project["id"],
            query="小王",
            viewer_user_id=outsider["id"],
        )

    # Owner can see it
    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="小王",
        viewer_user_id=owner["id"],
    )
    assert result.retrieval_count == 1

    # Subject can see it
    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="小王",
        viewer_user_id=member["id"],
    )
    assert result.retrieval_count == 1


def test_retrieve_reloads_from_project_memory(session: Session, client: TestClient):
    """FTS5 returns IDs that are reloaded and rechecked against ProjectMemory."""
    workspace, project, owner, *_ = _create_fixture(client)
    memory = _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="数据库字段过滤测试",
        rationale="测试",
    )

    # Mark memory superseded directly; FTS5 may still hold the old row
    memory.status = "superseded"
    session.add(memory)
    session.commit()

    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="数据库字段",
        viewer_user_id=owner["id"],
    )

    assert result.retrieval_count == 0


# ─── Context builder tests ───────────────────────────────────────────────────


def test_build_memory_context_truncates_by_token_budget(session: Session, client: TestClient):
    """Memory context is truncated to token budget and hard count."""
    workspace, project, owner, *_ = _create_fixture(client)
    for i in range(5):
        _write_memory(
            session,
            workspace_id=workspace["id"],
            project_id=project["id"],
            content=f"非常长的记忆内容，用来测试预算截断，编号 {i} " + "占字数" * 50,
            rationale="测试",
        )

    ctx = build_memory_context(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        query="记忆",
        token_budget=100,
        max_memories=2,
    )

    assert isinstance(ctx, MemoryContext)
    assert ctx.injected_count <= 2
    assert ctx.retrieval_count >= 2
    assert ctx.memory_backend == MemoryBackend.fts5


def test_build_memory_context_empty_when_no_memories(session: Session, client: TestClient):
    """When no memories match, context text is empty and injected count is zero."""
    workspace, project, owner, *_ = _create_fixture(client)

    ctx = build_memory_context(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        query="不存在的内容",
    )

    assert ctx.text == ""
    assert ctx.injected_count == 0
    assert ctx.retrieval_count == 0


# ─── AgentEvent metadata tests ───────────────────────────────────────────────


def test_agent_event_records_memory_metadata(session: Session, client: TestClient):
    """Legacy AgentEvent output_snapshot contains memory usage metadata."""
    workspace, project, owner, *_ = _create_fixture(client)
    _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="方向：聚焦任务协作闭环",
        rationale="方向卡确认",
    )

    from app.agent.workflow import generate_structured_output
    from app.agent.llm_client import MockLLMClient
    from app.models.enums import AgentEventType
    from app.services.workspace_state_service import get_workspace_state

    workspace_state = get_workspace_state(session, workspace["id"], project_id=project["id"])
    assert workspace_state is not None

    llm = MockLLMClient()
    generate_structured_output(
        session=session,
        workspace_state=workspace_state,
        event_type=AgentEventType.clarify,
        llm_client=llm,
        user_prompt="test",
        fallback_payload={
            "problem": "test",
            "users": "test",
            "value": "test",
            "deliverables": ["Demo"],
            "boundaries": [],
            "risks": [],
            "suggested_questions": [],
            "reason": "test reason",
            "requires_confirmation": True,
        },
        viewer_user_id=owner["id"],
    )

    from app.models import AgentEvent
    from sqlmodel import select
    event = session.exec(
        select(AgentEvent).where(AgentEvent.project_id == project["id"])
    ).first()
    assert event is not None
    output = event.get_output_snapshot()
    assert "_memory" in output
    memory_meta = output["_memory"]
    assert "used" in memory_meta
    assert "backend" in memory_meta
    assert "used_memory_ids" in memory_meta
    assert "retrieval_count" in memory_meta
    assert "injected_count" in memory_meta
    assert "latency_ms" in memory_meta


# ─── AgentRunState.side_effects tests ────────────────────────────────────────


def test_side_effects_does_not_record_memory_usage(client: TestClient, engine):
    """AgentRunV2 side_effects never contains memory usage metadata."""
    from app.models.agent_run_state import AgentRunV2

    workspace, project, owner, *_ = _create_fixture(client)

    response = client.post(
        "/internal/agent-runs",
        json={
            "viewer_user_id": owner["id"],
            "conversation_id": "conv_123",
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "user_content": "test",
        },
        headers={"Authorization": "Bearer test-internal-service-token"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["memory_context"] is not None

    # Verify side_effects does not contain memory metadata
    run_id = data["run_id"]
    with Session(engine) as session:
        run = session.get(AgentRunV2, run_id)
        assert run is not None
        side_effects = run.side_effects or []
        # side_effects is a list of strings; none should reference memory metadata
        for effect in side_effects:
            if isinstance(effect, str):
                assert "memory_used" not in effect
                assert "memory_backend" not in effect
                assert "used_memory_ids" not in effect


# ─── Viewer validation tests ─────────────────────────────────────────────────


def test_start_run_missing_viewer_returns_400(client: TestClient):
    """T41 start_run without viewer_user_id returns 400."""
    workspace, project, *_ = _create_fixture(client)

    response = client.post(
        "/internal/agent-runs",
        json={
            "conversation_id": "conv_123",
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "user_content": "test",
        },
        headers={"Authorization": "Bearer test-internal-service-token"},
    )
    assert response.status_code == 400


def test_start_run_outsider_viewer_returns_404(client: TestClient):
    """T41 start_run with viewer outside workspace returns 404."""
    workspace, project, *_owner, outsider = _create_fixture(client)

    response = client.post(
        "/internal/agent-runs",
        json={
            "viewer_user_id": outsider["id"],
            "conversation_id": "conv_123",
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "user_content": "test",
        },
        headers={"Authorization": "Bearer test-internal-service-token"},
    )
    assert response.status_code == 404


def test_conversation_message_missing_viewer_returns_400(client: TestClient):
    """Legacy conversation message without viewer_user_id returns 400."""
    workspace, project, owner, *_ = _create_fixture(client)
    conversation = client.get(
        f"/api/projects/{project['id']}/agent-conversation"
    ).json()

    response = client.post(
        f"/api/agent/conversations/{conversation['id']}/messages",
        json={"content": "hello"},
    )
    assert response.status_code == 400


def test_conversation_message_outsider_returns_404(client: TestClient):
    """Legacy conversation message with outsider viewer returns 404."""
    workspace, project, owner, _member, outsider = _create_fixture(client)
    conversation = client.get(
        f"/api/projects/{project['id']}/agent-conversation"
    ).json()

    response = client.post(
        f"/api/agent/conversations/{conversation['id']}/messages",
        json={"content": "hello", "viewer_user_id": outsider["id"]},
    )
    assert response.status_code == 404


# ─── Sidecar database-free architecture test ─────────────────────────────────


def test_sidecar_context_built_by_fastapi(client: TestClient):
    """RunStartResponse includes memory_context so sidecar does not query DB."""
    workspace, project, owner, *_ = _create_fixture(client)

    response = client.post(
        "/internal/agent-runs",
        json={
            "viewer_user_id": owner["id"],
            "conversation_id": "conv_123",
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "user_content": "方向",
        },
        headers={"Authorization": "Bearer test-internal-service-token"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "memory_context" in data
    assert isinstance(data["memory_context"], dict)
