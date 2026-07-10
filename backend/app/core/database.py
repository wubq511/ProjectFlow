import json

from sqlalchemy import inspect, text
from sqlmodel import SQLModel, Session, create_engine

from app.core.config import settings
import app.models  # noqa: F401 — ensure all models are registered before create_all

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
# For SQLite, provide JSON serializer/deserializer so Column(JSON) works
# with dict/list values even on Python 3.12+ where default adapters were removed.
_engine_kwargs = {}
if settings.database_url.startswith("sqlite"):
    _engine_kwargs["json_serializer"] = json.dumps
    _engine_kwargs["json_deserializer"] = json.loads
else:
    _engine_kwargs["pool_size"] = 5
    _engine_kwargs["max_overflow"] = 10
    _engine_kwargs["pool_recycle"] = 3600

engine = create_engine(settings.database_url, connect_args=connect_args, **_engine_kwargs)


def _get_sqlite_columns(table_name: str) -> set[str]:
    inspector = inspect(engine)
    if not inspector.has_table(table_name):
        return set()
    return {col["name"] for col in inspector.get_columns(table_name)}


def _migrate_agent_proposals() -> None:
    """Add missing rejection_reason column to agent_proposals if needed."""
    if not settings.database_url.startswith("sqlite"):
        return
    with engine.connect() as conn:
        columns = _get_sqlite_columns("agent_proposals")
        if "rejection_reason" not in columns:
            conn.execute(text("ALTER TABLE agent_proposals ADD COLUMN rejection_reason TEXT"))
            conn.commit()


def _migrate_tasks_order_index() -> None:
    """Add order_index column to tasks table if missing."""
    if not settings.database_url.startswith("sqlite"):
        return
    with engine.connect() as conn:
        columns = _get_sqlite_columns("tasks")
        if "order_index" not in columns:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0"))
            conn.commit()


def _migrate_workspaces() -> None:
    """Add workspace columns introduced after early demo databases were created."""
    if not settings.database_url.startswith("sqlite"):
        return
    with engine.connect() as conn:
        columns = _get_sqlite_columns("workspaces")
        if "team_size" not in columns:
            conn.execute(text("ALTER TABLE workspaces ADD COLUMN team_size INTEGER"))
        if "use_case" not in columns:
            conn.execute(text("ALTER TABLE workspaces ADD COLUMN use_case TEXT"))
        conn.commit()


def _migrate_agent_runs_v2() -> None:
    """Add viewer_user_id column to agent_runs_v2 if missing."""
    if not settings.database_url.startswith("sqlite"):
        return
    with engine.connect() as conn:
        columns = _get_sqlite_columns("agent_runs_v2")
        if "viewer_user_id" not in columns:
            conn.execute(text("ALTER TABLE agent_runs_v2 ADD COLUMN viewer_user_id TEXT NOT NULL DEFAULT ''"))
            conn.commit()


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)
    _migrate_agent_proposals()
    _migrate_tasks_order_index()
    _migrate_workspaces()
    _migrate_agent_runs_v2()


def get_session():
    with Session(engine) as session:
        try:
            yield session
        except Exception:
            session.rollback()
            raise
