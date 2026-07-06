"""Vector-only tests for ProjectMemory (Issue #77).

These tests require the memory-vector extra to be installed:
    pip install -e ".[memory-vector]"

They are automatically skipped in the default CI environment.
Run explicitly with:
    pytest app/tests/test_memory_vector.py -v
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.agent.memory.retriever import MemoryBackend, retrieve_memory_ids
from app.agent.memory.vector_retriever import VectorBackendError, is_vector_available
from app.core.database import get_session
from app.main import app
from app.services.memory_service import set_memory_engine


# Skip entire module if vector extra is not installed
_vector_available = is_vector_available()
pytestmark = pytest.mark.skipif(
    not _vector_available,
    reason="memory-vector extra not installed; run pip install -e '.[memory-vector]'",
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
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Member"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Vector Test WS"},
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
            "name": "Vector Test Project",
            "idea": "Test vector retrieval",
            "deadline": "2026-07-15",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    return workspace, project, owner, member


def test_is_vector_available_returns_true():
    """is_vector_available() returns True when extra is installed."""
    assert is_vector_available()


def test_vector_retriever_can_embed():
    """VectorRetriever can generate embeddings."""
    from app.agent.memory.vector_retriever import VectorRetriever
    from unittest.mock import MagicMock

    mock_conn = MagicMock()
    vr = VectorRetriever(mock_conn)

    embedding = vr.embed("测试文本")
    assert isinstance(embedding, list)
    assert len(embedding) > 0
    assert all(isinstance(v, float) for v in embedding)


def test_warmup_succeeds_with_vector_extra():
    """run_warmup() returns True when memory-vector extra is installed."""
    from app.memory.warmup import run_warmup

    result = run_warmup()
    assert result is True


def test_warmup_cli_exits_0_with_vector_extra():
    """python -m app.memory.warmup exits 0 when extra is installed."""
    import subprocess
    import sys

    result = subprocess.run(
        [sys.executable, "-m", "app.memory.warmup"],
        capture_output=True,
        text=True,
        cwd="backend",
        timeout=120,  # model download may take time
    )
    assert result.returncode == 0
