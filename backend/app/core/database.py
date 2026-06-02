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

engine = create_engine(settings.database_url, connect_args=connect_args, **_engine_kwargs)


def _migrate_agent_proposals() -> None:
    """Add missing rejection_reason column to agent_proposals if needed."""
    if not settings.database_url.startswith("sqlite"):
        return
    with engine.connect() as conn:
        inspector = inspect(engine)
        columns = {col["name"] for col in inspector.get_columns("agent_proposals")}
        if "rejection_reason" not in columns:
            conn.execute(text("ALTER TABLE agent_proposals ADD COLUMN rejection_reason TEXT"))
            conn.commit()


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)
    _migrate_agent_proposals()


def get_session():
    with Session(engine) as session:
        try:
            yield session
        except Exception:
            session.rollback()
            raise
