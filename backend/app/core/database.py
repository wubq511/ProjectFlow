import json

from sqlalchemy import event, inspect, text
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


if settings.database_url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()


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


def _migrate_agent_runs_v2_attribution() -> None:
    """Add resolved model attribution columns to agent_runs_v2 if missing."""
    if not settings.database_url.startswith("sqlite"):
        return
    with engine.connect() as conn:
        columns = _get_sqlite_columns("agent_runs_v2")
        if "resolved_model_provider" not in columns:
            conn.execute(text("ALTER TABLE agent_runs_v2 ADD COLUMN resolved_model_provider TEXT NOT NULL DEFAULT ''"))
        if "resolved_model_name" not in columns:
            conn.execute(text("ALTER TABLE agent_runs_v2 ADD COLUMN resolved_model_name TEXT NOT NULL DEFAULT ''"))
        if "model_fallback_reason" not in columns:
            conn.execute(text("ALTER TABLE agent_runs_v2 ADD COLUMN model_fallback_reason TEXT"))
        conn.commit()


def _migrate_agent_conversations_multi() -> None:
    """Migrate agent_conversations for multi-conversation support.

    - Add creator_user_id, title, visibility columns (idempotent)
    - Remove the unique constraint on project_id via safe parent-table swap
    - Migrate existing rows to visibility='team', title='项目历史对话'

    Safe SQLite parent-table pattern:
    - CREATE new parent with desired schema, INSERT from old, DROP old, RENAME new
    - No child tables (agent_messages, agent_runs, agent_runs_v2) are touched
    - PRAGMA foreign_keys=OFF during swap, re-enabled after commit
    """
    if not settings.database_url.startswith("sqlite"):
        return
    with engine.connect() as conn:
        columns = _get_sqlite_columns("agent_conversations")

        # Step 1: Add missing columns (idempotent)
        if "creator_user_id" not in columns:
            conn.execute(text("ALTER TABLE agent_conversations ADD COLUMN creator_user_id TEXT NOT NULL DEFAULT ''"))
        if "title" not in columns:
            conn.execute(text("ALTER TABLE agent_conversations ADD COLUMN title TEXT NOT NULL DEFAULT ''"))
        if "visibility" not in columns:
            conn.execute(text("ALTER TABLE agent_conversations ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'"))
        conn.commit()

        # Step 2: Migrate existing rows to team visibility with legacy title.
        # Only target legacy rows that have the empty creator_user_id default;
        # newly created private drafts also have visibility='private' and title=''
        # but carry a real creator_user_id, so they must NOT be converted.
        conn.execute(text(
            "UPDATE agent_conversations SET visibility = 'team', title = '项目历史对话' "
            "WHERE visibility = 'private' AND title = '' AND creator_user_id = ''"
        ))
        conn.commit()

        # Step 3: Check if unique constraint exists and remove it via safe parent-table swap.
        # The safe pattern avoids RENAME on the original table (which would trigger
        # SQLite's automatic FK rewriting in child tables like agent_messages,
        # agent_runs, and agent_runs_v2). Instead: CREATE new → INSERT → DROP old →
        # RENAME new. No child tables are touched; their FK references to
        # "agent_conversations(id)" resolve to the new table after the rename.
        indexes = conn.execute(text(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name='agent_conversations'"
        )).fetchall()
        table_sql = indexes[0][1] if indexes else ""
        if "uq_agent_conversations_project_id" in table_sql:
            conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
            try:
                # Create new parent table with complete desired schema (no unique constraint)
                conn.execute(text("""
                    CREATE TABLE agent_conversations_new (
                        id TEXT NOT NULL PRIMARY KEY,
                        workspace_id TEXT NOT NULL,
                        project_id TEXT NOT NULL,
                        creator_user_id TEXT NOT NULL DEFAULT '',
                        title TEXT NOT NULL DEFAULT '',
                        visibility TEXT NOT NULL DEFAULT 'private',
                        status TEXT NOT NULL DEFAULT 'active',
                        summary TEXT NOT NULL DEFAULT '',
                        current_focus TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMP NOT NULL,
                        updated_at TIMESTAMP NOT NULL,
                        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
                        FOREIGN KEY (project_id) REFERENCES projects(id)
                    )
                """))
                conn.execute(text("""
                    INSERT INTO agent_conversations_new
                        (id, workspace_id, project_id, creator_user_id, title, visibility,
                         status, summary, current_focus, created_at, updated_at)
                    SELECT
                        id, workspace_id, project_id,
                        COALESCE(creator_user_id, ''),
                        COALESCE(title, ''),
                        COALESCE(visibility, 'team'),
                        status, summary, current_focus, created_at, updated_at
                    FROM agent_conversations
                """))
                # DROP the original parent (FKs are off, child tables untouched).
                # Child tables' CREATE TABLE SQL still references "agent_conversations(id)".
                conn.execute(text("DROP TABLE agent_conversations"))
                # RENAME new table to original name — child FKs now resolve.
                conn.execute(text("ALTER TABLE agent_conversations_new RENAME TO agent_conversations"))

                # Recreate parent indexes
                conn.execute(text("CREATE INDEX ix_agent_conversations_workspace_id ON agent_conversations (workspace_id)"))
                conn.execute(text("CREATE INDEX ix_agent_conversations_project_id ON agent_conversations (project_id)"))
                conn.execute(text("CREATE INDEX ix_agent_conversations_creator_user_id ON agent_conversations (creator_user_id)"))
                conn.execute(text("CREATE INDEX ix_agent_conversations_visibility ON agent_conversations (visibility)"))
                conn.execute(text("CREATE INDEX ix_agent_conversations_status ON agent_conversations (status)"))
                conn.execute(text("CREATE INDEX ix_agent_conversations_project_updated ON agent_conversations (project_id, updated_at)"))
                conn.execute(text("CREATE INDEX ix_agent_conversations_project_creator ON agent_conversations (project_id, creator_user_id)"))
                conn.commit()
            finally:
                # SQLite ignores foreign_keys changes inside a transaction. Always
                # end the migration transaction before restoring enforcement, even
                # when one of the DDL statements fails.
                if conn.in_transaction():
                    conn.rollback()
                conn.exec_driver_sql("PRAGMA foreign_keys=ON")
                foreign_keys_enabled = conn.exec_driver_sql("PRAGMA foreign_keys").scalar_one()
                if foreign_keys_enabled != 1:
                    raise RuntimeError("SQLite foreign key enforcement could not be restored")


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)
    _migrate_agent_proposals()
    _migrate_tasks_order_index()
    _migrate_workspaces()
    _migrate_agent_runs_v2()
    _migrate_agent_runs_v2_attribution()
    _migrate_agent_conversations_multi()


def get_session():
    with Session(engine) as session:
        try:
            yield session
        except Exception:
            session.rollback()
            raise
