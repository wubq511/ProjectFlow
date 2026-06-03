"""Shared test fixtures for ProjectFlow backend tests."""
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

os.environ["APP_ENV"] = "development"
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["LLM_PROVIDER"] = "mock"
os.environ["LLM_API_KEY"] = ""

import pytest
from fastapi import FastAPI
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.database import get_session


# ---------------------------------------------------------------------------
# Ensure the SQLite data directory exists so file-backed DBs work in tests.
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_DATA_DIR = _BACKEND_DIR / "data"
_DATA_DIR.mkdir(exist_ok=True)


# ---------------------------------------------------------------------------
# In-memory SQLite with JSON support for integration tests that need TestClient.
# ---------------------------------------------------------------------------
@pytest.fixture
def client():
    """Yield a TestClient backed by an in-memory SQLite with all tables created.

    This overrides the ``get_session`` dependency so the FastAPI app uses the
    test database instead of the default file-backed one.  The lifespan is
    replaced with a no-op so that the default engine is never touched.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    def _override_session():
        with Session(engine) as session:
            yield session

    # Replace the lifespan with a no-op: table creation is already done above
    # against the in-memory engine, so the default file-backed engine is never used.
    @asynccontextmanager
    async def _noop_lifespan(app: FastAPI):
        yield

    app.router.lifespan_context = _noop_lifespan

    app.dependency_overrides[get_session] = _override_session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
