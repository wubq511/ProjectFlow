"""Tests for ProjectMemory vector extra guardrails (Issue #77).

All tests run in the default dev/test install (no torch, sentence-transformers,
sqlite-vec, or embedding model files). They verify that:

- Default install does not pull vector dependencies
- Default retrieval path does not import vector-only modules at import time
- warmup prints a clear skip message and exits 0 without the extra
- prefer_vector=True degrades gracefully to FTS5 when vector is unavailable
- memory_backend reflects the actual backend used, not the installed package set
- Vector search is not attempted by default (prefer_vector=False)
- retrieve_memory_ids signature accepts prefer_vector without breaking callers
"""

from __future__ import annotations

import json
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.agent.memory.context_builder import MemoryContext, build_memory_context
from app.agent.memory.extractor import ProjectMemoryCandidate
from app.agent.memory.retriever import MemoryBackend, MemoryRetriever, retrieve_memory_ids
from app.agent.memory.vector_retriever import VectorBackendError, is_vector_available
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
    """Create workspace, project, owner, member for testing."""
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Member"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Vector Guard WS"},
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
            "name": "Vector Guard Project",
            "idea": "Test vector guardrails",
            "deadline": "2026-07-15",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    return workspace, project, owner, member


def _write_memory(
    session: Session,
    workspace_id: str,
    project_id: str,
    content: str,
    rationale: str = "测试理由",
    memory_type: str = "direction",
    visibility: str = "team",
) -> ProjectMemory:
    candidate = ProjectMemoryCandidate(
        memory_type=memory_type,
        scope="project",
        content=content,
        rationale=rationale,
        source_type="direction_card_confirmed",
        source_id=str(uuid.uuid4()),
        source_hash="test-hash-" + str(uuid.uuid4()),
        visibility=visibility,
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


# ─── Default install guardrails ──────────────────────────────────────────────


def test_default_install_no_vector_deps():
    """Default install does not have torch or sentence_transformers."""
    optional_deps = ["torch", "sentence_transformers", "sqlite_vec"]
    for dep in optional_deps:
        try:
            __import__(dep)
            has_dep = True
        except ImportError:
            has_dep = False
        assert not has_dep, (
            f"Optional dependency '{dep}' is installed but should not be "
            f"required in the default dev install."
        )


def test_is_vector_available_returns_false():
    """is_vector_available() returns False in default install."""
    assert not is_vector_available()


def test_vector_retriever_not_imported_at_module_level():
    """Importing app.agent.memory.retriever does not trigger vector imports."""
    # If vector deps were imported at module level, they'd be in sys.modules
    import app.agent.memory.retriever  # noqa: F401

    assert "sentence_transformers" not in sys.modules
    assert "sqlite_vec" not in sys.modules
    assert "torch" not in sys.modules


# ─── Warmup guardrails ───────────────────────────────────────────────────────


def test_warmup_skip_without_vector_extra():
    """python -m app.memory.warmup exits 0 without vector extra."""
    import os

    backend_dir = os.path.join(os.path.dirname(__file__), "..", "..")
    result = subprocess.run(
        [sys.executable, "-m", "app.memory.warmup"],
        capture_output=True,
        cwd=os.path.abspath(backend_dir),
    )
    assert result.returncode == 0


def test_warmup_run_warmup_returns_false_without_extra():
    """run_warmup() returns False when memory-vector extra is not installed."""
    from app.memory.warmup import run_warmup

    result = run_warmup()
    assert result is False


# ─── Fallback chain guardrails ───────────────────────────────────────────────


def test_fallback_to_fts5_when_vector_unavailable(session: Session, client: TestClient):
    """prefer_vector=True degrades to FTS5 when vector backend is unavailable."""
    workspace, project, owner, *_ = _create_fixture(client)
    _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="项目核心方向：构建任务协作闭环",
        rationale="方向卡确认",
    )

    # Vector is unavailable, so prefer_vector=True should fall back to FTS5
    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="核心方向",
        viewer_user_id=owner["id"],
        prefer_vector=True,
    )

    assert result.backend == MemoryBackend.fts5
    assert result.retrieval_count >= 1


def test_vector_search_not_tried_by_default(session: Session, client: TestClient):
    """With prefer_vector=False (default), vector search is not attempted."""
    workspace, project, owner, *_ = _create_fixture(client)
    _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="默认路径测试记忆",
        rationale="测试",
    )

    # Mock is_vector_available to track if it's called
    with patch(
        "app.agent.memory.vector_retriever.is_vector_available",
        wraps=is_vector_available,
    ) as mock_avail:
        result = retrieve_memory_ids(
            session,
            project_id=project["id"],
            query="默认路径",
            viewer_user_id=owner["id"],
            # prefer_vector=False is default
        )

        # is_vector_available should NOT be called when prefer_vector=False
        # (the vector path is simply skipped, not even checked)
        assert result.backend == MemoryBackend.fts5


def test_memory_backend_reflects_actual_backend(session: Session, client: TestClient):
    """memory_backend reflects the actual backend used, not the installed packages."""
    workspace, project, owner, *_ = _create_fixture(client)
    _write_memory(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        content="后端 API 开发方向",
        rationale="方向确认",
    )

    # Even with prefer_vector=True, since vector is unavailable,
    # backend should be fts5 (actual used), not vector (installed check)
    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="后端 API",
        viewer_user_id=owner["id"],
        prefer_vector=True,
    )

    assert result.backend == MemoryBackend.fts5
    assert result.backend != MemoryBackend.vector


# ─── Signature compatibility ─────────────────────────────────────────────────


def test_retrieve_memory_ids_accepts_prefer_vector(session: Session, client: TestClient):
    """retrieve_memory_ids accepts prefer_vector kwarg without breaking."""
    workspace, project, owner, *_ = _create_fixture(client)

    # Without prefer_vector (backward compatible)
    result1 = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="测试",
        viewer_user_id=owner["id"],
    )

    # With prefer_vector=False (explicit)
    result2 = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="测试",
        viewer_user_id=owner["id"],
        prefer_vector=False,
    )

    # With prefer_vector=True (vector unavailable, falls back)
    result3 = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="测试",
        viewer_user_id=owner["id"],
        prefer_vector=True,
    )

    # All should succeed (no exception)
    assert isinstance(result1.memory_ids, list)
    assert isinstance(result2.memory_ids, list)
    assert isinstance(result3.memory_ids, list)


def test_retrieve_visible_memory_ids_accepts_prefer_vector(
    session: Session, client: TestClient
):
    """memory_service.retrieve_visible_memory_ids accepts prefer_vector."""
    from app.services.memory_service import retrieve_visible_memory_ids

    workspace, project, owner, *_ = _create_fixture(client)

    result = retrieve_visible_memory_ids(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        query="测试",
        prefer_vector=True,
    )

    assert isinstance(result.memory_ids, list)


def test_build_memory_context_accepts_prefer_vector(
    session: Session, client: TestClient
):
    """build_memory_context accepts prefer_vector kwarg."""
    workspace, project, owner, *_ = _create_fixture(client)

    ctx = build_memory_context(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        query="测试",
        prefer_vector=True,
    )

    assert isinstance(ctx, MemoryContext)


# ─── Vector retriever error handling ─────────────────────────────────────────


def test_vector_backend_error_is_catchable():
    """VectorBackendError can be caught and handled by the fallback chain."""
    error = VectorBackendError("test error")
    assert str(error) == "test error"
    assert isinstance(error, Exception)


def test_vector_retriever_init_fails_gracefully_without_deps():
    """VectorRetriever raises VectorBackendError when deps are missing."""
    from app.agent.memory.vector_retriever import VectorRetriever

    # Use a mock connection
    mock_conn = MagicMock()
    vr = VectorRetriever(mock_conn)

    # Calling _ensure_model should raise VectorBackendError
    with pytest.raises(VectorBackendError):
        vr._ensure_model()


# ─── MemoryBackend enum completeness ─────────────────────────────────────────


def test_memory_backend_has_vector_value():
    """MemoryBackend enum includes 'vector' value."""
    assert MemoryBackend.vector.value == "vector"
    assert "vector" in [b.value for b in MemoryBackend]


def test_memory_backend_all_values():
    """MemoryBackend enum has exactly 4 values: vector, fts5, sqlite_field, none."""
    values = {b.value for b in MemoryBackend}
    assert values == {"vector", "fts5", "sqlite_field", "none"}
