import json

from sqlalchemy import create_engine, inspect, text

from app.core import database


def test_create_db_and_tables_adds_workspace_columns_for_legacy_sqlite(monkeypatch, tmp_path):
    db_path = tmp_path / "legacy.sqlite"
    legacy_engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE workspaces (
                    id VARCHAR NOT NULL PRIMARY KEY,
                    name VARCHAR NOT NULL,
                    owner_user_id VARCHAR NOT NULL,
                    description VARCHAR,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL
                )
                """
            )
        )

    monkeypatch.setattr(database, "engine", legacy_engine)
    monkeypatch.setattr(database.settings, "database_url", f"sqlite:///{db_path}")

    database.create_db_and_tables()

    columns = {col["name"] for col in inspect(legacy_engine).get_columns("workspaces")}
    assert {"team_size", "project_template"} <= columns


def test_create_db_and_tables_maps_legacy_workspace_use_case(monkeypatch, tmp_path):
    db_path = tmp_path / "legacy-workspace-use-case.sqlite"
    legacy_engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    with legacy_engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE workspaces (
                id VARCHAR NOT NULL PRIMARY KEY,
                name VARCHAR NOT NULL,
                owner_user_id VARCHAR NOT NULL,
                description VARCHAR,
                team_size INTEGER,
                use_case VARCHAR,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
        """))
        for workspace_id, use_case in [
            ("course", "course"),
            ("competition", "competition"),
            ("startup", "startup"),
            ("research", "research"),
            ("other", "other"),
        ]:
            conn.execute(
                text("""
                    INSERT INTO workspaces (
                        id, name, owner_user_id, use_case, created_at, updated_at
                    ) VALUES (
                        :id, :id, 'owner', :use_case, '2026-07-01', '2026-07-01'
                    )
                """),
                {"id": workspace_id, "use_case": use_case},
            )

    monkeypatch.setattr(database, "engine", legacy_engine)
    monkeypatch.setattr(database.settings, "database_url", f"sqlite:///{db_path}")

    database.create_db_and_tables()
    database.create_db_and_tables()

    with legacy_engine.connect() as conn:
        templates = dict(conn.execute(text(
            "SELECT id, project_template FROM workspaces ORDER BY id"
        )).all())
    assert templates == {
        "competition": "competition",
        "course": "coursework",
        "other": "general",
        "research": "research",
        "startup": "startup",
    }


def test_create_db_and_tables_preserves_legacy_projects_with_general_template(monkeypatch, tmp_path):
    db_path = tmp_path / "legacy-projects.sqlite"
    legacy_engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    with legacy_engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE projects (
                id VARCHAR NOT NULL PRIMARY KEY,
                workspace_id VARCHAR NOT NULL,
                name VARCHAR NOT NULL,
                idea VARCHAR NOT NULL,
                deadline VARCHAR NOT NULL,
                deliverables VARCHAR NOT NULL,
                status VARCHAR NOT NULL,
                current_stage_id VARCHAR,
                direction_card VARCHAR,
                created_by VARCHAR NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
        """))
        conn.execute(text("""
            INSERT INTO projects (
                id, workspace_id, name, idea, deadline, deliverables,
                status, created_by, created_at, updated_at
            ) VALUES (
                'legacy-project', 'legacy-workspace', '旧项目', '既有想法',
                '2026-12-31', '原型', 'draft', 'legacy-user',
                '2026-07-01', '2026-07-01'
            )
        """))

    monkeypatch.setattr(database, "engine", legacy_engine)
    monkeypatch.setattr(database.settings, "database_url", f"sqlite:///{db_path}")

    database.create_db_and_tables()
    database.create_db_and_tables()

    columns = {col["name"] for col in inspect(legacy_engine).get_columns("projects")}
    assert "project_template" in columns
    with legacy_engine.connect() as conn:
        template = conn.execute(
            text("SELECT project_template FROM projects WHERE id = 'legacy-project'")
        ).scalar_one()
    assert template == "general"
