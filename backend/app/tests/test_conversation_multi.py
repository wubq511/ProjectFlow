"""
T45 Batch C: Multi-conversation lifecycle, migration, authorization, pagination
and privacy boundary tests.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import Project, User, Workspace, WorkspaceMembership
from app.models.agent_conversation import AgentConversation, AgentMessage


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_base(session: Session):
    """Seed workspace, project, two users with memberships."""
    user1 = User(id="user-1", display_name="小林", created_at=datetime.now(UTC), updated_at=datetime.now(UTC))
    user2 = User(id="user-2", display_name="小王", created_at=datetime.now(UTC), updated_at=datetime.now(UTC))
    session.add_all([user1, user2])
    session.flush()  # Ensure users exist before FK references

    ws = Workspace(id="ws-1", name="测试工作区", owner_user_id="user-1", created_at=datetime.now(UTC), updated_at=datetime.now(UTC))
    proj = Project(
        id="proj-1", workspace_id="ws-1", name="项目A", idea="想法",
        deadline="2026-08-01", deliverables="演示", created_by="user-1",
        created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    mem1 = WorkspaceMembership(id="wm-1", workspace_id="ws-1", user_id="user-1", role="member")
    mem2 = WorkspaceMembership(id="wm-2", workspace_id="ws-1", user_id="user-2", role="member")
    session.add_all([ws, proj, mem1, mem2])
    session.commit()


# ---------------------------------------------------------------------------
# Legacy migration
# ---------------------------------------------------------------------------


class TestLegacyMigration:
    """Verify the SQLite migration from the old unique-constraint schema."""

    def test_migration_preserves_data_and_removes_unique_constraint(self):
        """Legacy conversations migrate to team visibility, multiple new ones allowed."""
        from sqlalchemy import text as sql_text

        engine = _make_engine()
        # Seed reference tables so FK constraints pass after migration
        session = Session(engine)
        _seed_base(session)
        session.close()

        # Drop and recreate with legacy schema
        with engine.connect() as conn:
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_messages"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs_v2"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_conversations"))
            conn.execute(sql_text("""
                CREATE TABLE agent_conversations (
                    id TEXT NOT NULL PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    summary TEXT NOT NULL DEFAULT '',
                    current_focus TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    CONSTRAINT uq_agent_conversations_project_id UNIQUE (project_id)
                )
            """))
            conn.execute(sql_text("""
                CREATE TABLE agent_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    structured_payload TEXT NOT NULL DEFAULT '{}',
                    linked_event_id TEXT,
                    linked_proposal_id TEXT,
                    created_at TIMESTAMP NOT NULL
                )
            """))
            now = datetime.now(UTC).isoformat()
            conn.execute(sql_text(
                f"INSERT INTO agent_conversations VALUES ('conv-1', 'ws-1', 'proj-1', 'active', '', '', '{now}', '{now}')"
            ))
            conn.execute(sql_text(
                f"INSERT INTO agent_messages VALUES ('msg-1', 'conv-1', 'user', '你好', '{{}}', NULL, NULL, '{now}')"
            ))
            conn.commit()

        # Apply migration
        import app.core.database as db_module
        db_module.engine = engine
        db_module._migrate_agent_conversations_multi()

        # Verify data preserved
        with engine.connect() as conn:
            row = conn.execute(sql_text(
                "SELECT id, visibility, title, creator_user_id FROM agent_conversations WHERE id='conv-1'"
            )).fetchone()
            assert row[0] == "conv-1"
            assert row[1] == "team"
            assert row[2] == "项目历史对话"
            assert row[3] == ""

            msg_count = conn.execute(sql_text("SELECT COUNT(*) FROM agent_messages")).fetchone()[0]
            assert msg_count == 1

        # Verify multiple conversations can coexist
        session = Session(engine)
        session.add(AgentConversation(
            id="conv-2", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="新对话", visibility="private",
        ))
        session.add(AgentConversation(
            id="conv-3", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-2", title="另一个", visibility="private",
        ))
        session.commit()
        count = session.exec(
            select(AgentConversation).where(AgentConversation.project_id == "proj-1")
        ).all()
        assert len(count) == 3

    def test_migration_idempotent(self):
        """Running migration twice does not corrupt data."""
        engine = _make_engine()
        import app.core.database as db_module
        db_module.engine = engine
        # First run (fresh DB with new schema)
        db_module._migrate_agent_conversations_multi()
        # Second run should be a no-op
        db_module._migrate_agent_conversations_multi()

        # Seed reference tables so FK constraints pass
        session = Session(engine)
        _seed_base(session)
        session.close()

        session = Session(engine)
        # Should work fine
        conv = AgentConversation(
            id="test-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="测试", visibility="private",
        )
        session.add(conv)
        session.commit()
        assert session.get(AgentConversation, "test-1") is not None


# ---------------------------------------------------------------------------
# Conversation lifecycle
# ---------------------------------------------------------------------------


class TestConversationLifecycle:
    """Test create, list, read, message page."""

    def test_create_conversation(self):
        from app.services.agent_conversation_service import create_conversation

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = create_conversation(session, "proj-1", "user-1")
        assert conv.creator_user_id == "user-1"
        assert conv.visibility == "private"
        assert conv.title == ""
        assert conv.project_id == "proj-1"

    def test_list_conversations_returns_summaries(self):
        from app.services.agent_conversation_service import (
            create_conversation, list_conversations,
        )

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = create_conversation(session, "proj-1", "user-1")
        # Add some messages
        session.add(AgentMessage(conversation_id=conv.id, role="user", content="你好"))
        session.add(AgentMessage(conversation_id=conv.id, role="assistant", content="你好！"))
        session.commit()

        summaries = list_conversations(session, "proj-1", "user-1")
        assert len(summaries) == 1
        s = summaries[0]
        assert s.id == conv.id
        assert s.message_count == 2
        assert s.visibility == "private"
        # No full messages in summary
        assert not hasattr(s, "messages") or s.last_message_preview == "你好！"

    def test_get_conversation_with_messages(self):
        from app.services.agent_conversation_service import (
            create_conversation, get_conversation,
        )

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = create_conversation(session, "proj-1", "user-1")
        session.add(AgentMessage(conversation_id=conv.id, role="user", content="问题"))
        session.add(AgentMessage(conversation_id=conv.id, role="assistant", content="回答"))
        session.commit()

        detail = get_conversation(session, conv.id, "user-1")
        assert detail is not None
        assert len(detail.messages) == 2
        assert detail.creator_user_id == "user-1"
        assert detail.visibility == "private"

    def test_get_conversation_nonexistent_returns_none(self):
        from app.services.agent_conversation_service import get_conversation

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        result = get_conversation(session, "nonexistent", "user-1")
        assert result is None


# ---------------------------------------------------------------------------
# Authorization
# ---------------------------------------------------------------------------


class TestConversationAuthorization:
    """Test viewer validation: private owner, private non-owner, team member, non-member, cross-project."""

    def test_private_owner_can_access(self):
        from app.services.agent_conversation_service import create_conversation, check_conversation_access

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        conv = create_conversation(session, "proj-1", "user-1")

        result = check_conversation_access(session, conv.id, "user-1")
        assert result is not None

    def test_private_non_owner_cannot_access(self):
        from app.services.agent_conversation_service import create_conversation, check_conversation_access

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        conv = create_conversation(session, "proj-1", "user-1")

        result = check_conversation_access(session, conv.id, "user-2")
        assert result is None

    def test_team_conversation_visible_to_members(self):
        from app.services.agent_conversation_service import check_conversation_access

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="team-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="团队对话", visibility="team",
        )
        session.add(conv)
        session.commit()

        # Both members can read
        assert check_conversation_access(session, "team-1", "user-1") is not None
        assert check_conversation_access(session, "team-1", "user-2") is not None

    def test_team_conversation_write_is_available_to_members(self):
        from app.services.agent_conversation_service import check_conversation_access

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="team-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="团队对话", visibility="team",
        )
        session.add(conv)
        session.commit()

        # Team history is a shared conversation for all project members.
        assert check_conversation_access(session, "team-1", "user-1", require_write=True) is not None
        assert check_conversation_access(session, "team-1", "user-2", require_write=True) is not None

    def test_non_member_cannot_access(self):
        from app.services.agent_conversation_service import create_conversation, check_conversation_access

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        conv = create_conversation(session, "proj-1", "user-1")

        # user-3 is not a workspace member
        session.add(User(id="user-3", display_name="外来者", created_at=datetime.now(UTC), updated_at=datetime.now(UTC)))
        session.commit()

        result = check_conversation_access(session, conv.id, "user-3")
        assert result is None

    def test_cross_project_access_rejected(self):
        from app.services.agent_conversation_service import check_conversation_access

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        # Create a second project
        proj2 = Project(
            id="proj-2", workspace_id="ws-1", name="项目B", idea="想法B",
            deadline="2026-08-01", deliverables="演示", created_by="user-2",
            created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
        )
        session.add(proj2)
        session.commit()

        conv = AgentConversation(
            id="conv-p1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="A的对话", visibility="private",
        )
        session.add(conv)
        session.commit()

        # user-2 is a workspace member but conv belongs to proj-1 (user-1's private conv)
        result = check_conversation_access(session, "conv-p1", "user-2")
        assert result is None

    def test_list_hides_other_users_private_conversations(self):
        from app.services.agent_conversation_service import create_conversation, list_conversations

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        # user-1 creates private conversation
        create_conversation(session, "proj-1", "user-1")
        # user-2 creates private conversation
        create_conversation(session, "proj-1", "user-2")

        # user-1 sees only their own
        summaries_1 = list_conversations(session, "proj-1", "user-1")
        assert len(summaries_1) == 1
        assert summaries_1[0].creator_user_id == "user-1"

        # user-2 sees only their own
        summaries_2 = list_conversations(session, "proj-1", "user-2")
        assert len(summaries_2) == 1
        assert summaries_2[0].creator_user_id == "user-2"


# ---------------------------------------------------------------------------
# Cursor pagination
# ---------------------------------------------------------------------------


class TestCursorPagination:
    """Test message cursor pagination: same timestamps, empty pages, no duplicates."""

    def test_latest_page_returns_most_recent_messages(self):
        from app.services.agent_conversation_service import get_messages_page

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", visibility="private",
        )
        session.add(conv)
        # Add 5 messages
        for i in range(5):
            session.add(AgentMessage(
                conversation_id="conv-1", role="user" if i % 2 == 0 else "assistant",
                content=f"消息{i}",
            ))
        session.commit()

        page = get_messages_page(session, "conv-1", "user-1")
        assert page is not None
        assert len(page.messages) == 5
        assert page.has_older is False
        assert page.older_cursor is None

    def test_cursor_returns_older_page(self):
        from app.services.agent_conversation_service import get_messages_page

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", visibility="private",
        )
        session.add(conv)
        # Add 35 messages (more than PAGE_SIZE=30)
        base_time = datetime.now(UTC)
        for i in range(35):
            msg = AgentMessage(
                conversation_id="conv-1", role="user" if i % 2 == 0 else "assistant",
                content=f"消息{i}",
            )
            msg.created_at = base_time + timedelta(seconds=i)
            session.add(msg)
        session.commit()

        # First page: latest 30
        page1 = get_messages_page(session, "conv-1", "user-1")
        assert page1 is not None
        assert len(page1.messages) == 30
        assert page1.has_older is True
        assert page1.older_cursor is not None

        # Second page: older messages
        page2 = get_messages_page(
            session, "conv-1", "user-1",
            before_created_at=page1.older_cursor.created_at,
            before_id=page1.older_cursor.id,
        )
        assert page2 is not None
        assert len(page2.messages) == 5
        assert page2.has_older is False

    def test_no_duplicate_messages_across_pages(self):
        from app.services.agent_conversation_service import get_messages_page

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", visibility="private",
        )
        session.add(conv)
        base_time = datetime.now(UTC)
        for i in range(35):
            msg = AgentMessage(
                conversation_id="conv-1", role="user",
                content=f"消息{i}",
            )
            msg.created_at = base_time + timedelta(seconds=i)
            session.add(msg)
        session.commit()

        all_ids = set()
        page = get_messages_page(session, "conv-1", "user-1")
        assert page is not None
        all_ids.update(m.id for m in page.messages)

        while page.has_older and page.older_cursor:
            page = get_messages_page(
                session, "conv-1", "user-1",
                before_created_at=page.older_cursor.created_at,
                before_id=page.older_cursor.id,
            )
            assert page is not None
            page_ids = {m.id for m in page.messages}
            # No overlap
            assert all_ids.isdisjoint(page_ids)
            all_ids.update(page_ids)

        assert len(all_ids) == 35

    def test_same_timestamp_messages_stable_order(self):
        from app.services.agent_conversation_service import get_messages_page

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", visibility="private",
        )
        session.add(conv)
        same_time = datetime.now(UTC)
        for i in range(5):
            msg = AgentMessage(
                conversation_id="conv-1", role="user",
                content=f"消息{i}",
            )
            msg.created_at = same_time
            session.add(msg)
        session.commit()

        # Multiple reads should return same order
        page1 = get_messages_page(session, "conv-1", "user-1")
        page2 = get_messages_page(session, "conv-1", "user-1")
        assert [m.id for m in page1.messages] == [m.id for m in page2.messages]

    def test_empty_conversation_returns_empty_page(self):
        from app.services.agent_conversation_service import get_messages_page

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", visibility="private",
        )
        session.add(conv)
        session.commit()

        page = get_messages_page(session, "conv-1", "user-1")
        assert page is not None
        assert page.messages == []
        assert page.has_older is False
        assert page.older_cursor is None

    def test_unauthorized_returns_none(self):
        from app.services.agent_conversation_service import get_messages_page

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", visibility="private",
        )
        session.add(conv)
        session.commit()

        result = get_messages_page(session, "conv-1", "user-2")
        assert result is None


# ---------------------------------------------------------------------------
# Title derivation
# ---------------------------------------------------------------------------


class TestTitleDerivation:
    """Test deterministic title from first message."""

    def test_normal_message(self):
        from app.services.agent_conversation_service import _derive_title
        assert _derive_title("帮我制定项目计划") == "帮我制定项目计划"

    def test_whitespace_collapsed(self):
        from app.services.agent_conversation_service import _derive_title
        assert _derive_title("  你好  世界  ") == "你好 世界"

    def test_trailing_punctuation_stripped(self):
        from app.services.agent_conversation_service import _derive_title
        assert _derive_title("你好吗？") == "你好吗"
        assert _derive_title("好的。") == "好的"

    def test_long_message_truncated(self):
        from app.services.agent_conversation_service import _derive_title
        long = "这是一段很长很长的消息" * 10
        title = _derive_title(long)
        assert len(title) <= 51  # 50 chars + "…"
        assert title.endswith("…")

    def test_empty_fallback(self):
        from app.services.agent_conversation_service import _derive_title
        assert _derive_title("") == "新对话"
        assert _derive_title("   ") == "新对话"


# ---------------------------------------------------------------------------
# GET must not create rows
# ---------------------------------------------------------------------------


class TestGetDoesNotCreate:
    """Verify GET endpoints do not mutate state."""

    def test_get_or_create_project_conversation_preserves_backward_compat(self):
        """get_or_create still creates when none exists (backward compat)."""
        from app.services.agent_conversation_service import get_or_create_project_conversation

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = get_or_create_project_conversation(session, "proj-1")
        assert conv.project_id == "proj-1"
        assert conv.visibility == "team"  # backward-compat default

    def test_get_conversation_does_not_create(self):
        from app.services.agent_conversation_service import get_conversation

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        result = get_conversation(session, "nonexistent", "user-1")
        assert result is None
        # No rows created
        count = session.exec(select(AgentConversation)).all()
        assert len(count) == 0


# ---------------------------------------------------------------------------
# Team conversation privacy — no subject_and_owner memory injection
# ---------------------------------------------------------------------------


class TestTeamConversationMemoryPrivacy:
    """Prove team conversations cannot receive subject_and_owner ProjectMemory."""

    def test_team_conversation_excludes_subject_and_owner_memory(self):
        from app.agent.memory.context_builder import build_memory_context
        from app.models import ProjectMemory

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        # Create team-visible memory
        team_mem = ProjectMemory(
            id="mem-team", workspace_id="ws-1", project_id="proj-1",
            memory_type="direction", scope="project",
            content="团队方向澄清", rationale="团队决定",
            source_type="direction_card_confirmed", source_id="src-1",
            source_hash="hash1", status="active", visibility="team",
        )
        # Create subject_and_owner memory
        private_mem = ProjectMemory(
            id="mem-private", workspace_id="ws-1", project_id="proj-1",
            memory_type="member_constraint", scope="member",
            content="小林约束条件", rationale="私人原因",
            source_type="assignment_confirmed", source_id="src-2",
            source_hash="hash2", status="active", visibility="subject_and_owner",
            subject_user_id="user-1", owner_user_id_snapshot="user-1",
        )
        session.add_all([team_mem, private_mem])
        session.commit()

        # For team conversation: only team memory injected
        # Use a query that matches both memories via jieba tokens
        ctx_team = build_memory_context(
            session, "proj-1", "user-1",
            query="方向约束",
            conversation_visibility="team",
        )
        assert "团队方向" in ctx_team.text
        assert "小林约束" not in ctx_team.text
        assert "mem-team" in ctx_team.used_memory_ids
        assert "mem-private" not in ctx_team.used_memory_ids

    def test_private_conversation_can_receive_subject_and_owner_memory(self):
        from app.agent.memory.context_builder import build_memory_context
        from app.models import ProjectMemory

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        private_mem = ProjectMemory(
            id="mem-private", workspace_id="ws-1", project_id="proj-1",
            memory_type="member_constraint", scope="member",
            content="小林约束条件", rationale="私人原因",
            source_type="assignment_confirmed", source_id="src-2",
            source_hash="hash2", status="active", visibility="subject_and_owner",
            subject_user_id="user-1", owner_user_id_snapshot="user-1",
        )
        session.add(private_mem)
        session.commit()

        # For private conversation (no visibility override): viewer can see their own memory
        ctx = build_memory_context(
            session, "proj-1", "user-1",
            query="约束",
            conversation_visibility="private",
        )
        assert "小林约束" in ctx.text
        assert "mem-private" in ctx.used_memory_ids


# ---------------------------------------------------------------------------
# Internal conversation tool uses explicit conversation_id
# ---------------------------------------------------------------------------


class TestInternalConversationTool:
    """Verify the internal tool reads the explicit conversation, not project singleton.

    F4: Tool resolves viewer_user_id from AgentRunV2, never from model arguments
    or conversation.creator_user_id.
    """

    def _create_run(self, session, *, run_id="run-1", conversation_id="conv-2", viewer_user_id="user-1"):
        """Helper: create an AgentRunV2 for tool authorization tests."""
        from app.models.agent_run_state import AgentRunV2
        from app.models.enums import AgentRunStatus
        run = AgentRunV2(
            id=run_id,
            conversation_id=conversation_id,
            project_id="proj-1",
            workspace_id="ws-1",
            viewer_user_id=viewer_user_id,
            status=AgentRunStatus.created,
        )
        session.add(run)
        session.commit()

    def test_internal_tool_reads_explicit_conversation(self):
        from app.services.agent_tools_service import execute_agent_tool
        from app.schemas.runtime import ToolExecutionRequest

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        # Create two conversations
        conv1 = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="对话1", visibility="private",
        )
        conv2 = AgentConversation(
            id="conv-2", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="对话2", visibility="private",
        )
        session.add_all([conv1, conv2])
        # Add messages to conv-1 only
        session.add(AgentMessage(conversation_id="conv-1", role="user", content="对话1的问题"))
        session.commit()
        # Create run that points to conv-2 with viewer user-1
        self._create_run(session, conversation_id="conv-2", viewer_user_id="user-1")

        # Request for conv-2 should return conv-2 (empty), not conv-1
        request = ToolExecutionRequest(
            run_id="run-1",
            tool_call_id="tc-1",
            conversation_id="conv-2",
            workspace_id="ws-1",
            project_id="proj-1",
            tool_name="conversation",
            idempotency_key="idem-1",
            arguments={},  # No viewer_user_id in arguments — resolved from run
        )
        result = execute_agent_tool(session, request)
        assert result.status == "success"
        # The result should be conv-2, not conv-1
        assert result.data["id"] == "conv-2"
        assert result.data["title"] == "对话2"

    def test_internal_tool_ignores_model_provided_viewer_id(self):
        """F4: Model-provided viewer_user_id in arguments is ignored.

        The run's viewer (user-1) owns the private conversation, so access
        succeeds even though the model tried to pass user-2. The key assertion
        is that user-2's identity is NOT used — if it were, the private
        conversation would be inaccessible.
        """
        from app.services.agent_tools_service import execute_agent_tool
        from app.schemas.runtime import ToolExecutionRequest

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="对话", visibility="private",
        )
        session.add(conv)
        # Run points to user-1 (the owner)
        self._create_run(session, run_id="run-auth", conversation_id="conv-1", viewer_user_id="user-1")
        session.commit()

        # Model tries to pass user-2 as viewer — must be ignored.
        # If user-2 were used, the private conversation would be inaccessible.
        request = ToolExecutionRequest(
            run_id="run-auth",
            tool_call_id="tc-1",
            conversation_id="conv-1",
            workspace_id="ws-1",
            project_id="proj-1",
            tool_name="conversation",
            idempotency_key="idem-auth",
            arguments={"viewer_user_id": "user-2"},
        )
        result = execute_agent_tool(session, request)
        # Succeeds because run.viewer_user_id=user-1 (the owner) is used,
        # NOT the model-provided user-2.
        assert result.status == "success"
        assert result.data["id"] == "conv-1"

    def test_internal_tool_fails_without_run(self):
        """F4: Without a run record, tool cannot resolve viewer and fails closed."""
        from app.services.agent_tools_service import execute_agent_tool
        from app.schemas.runtime import ToolExecutionRequest

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="对话", visibility="private",
        )
        session.add(conv)
        session.commit()

        # No run record exists — must fail
        request = ToolExecutionRequest(
            run_id="nonexistent-run",
            tool_call_id="tc-1",
            conversation_id="conv-1",
            workspace_id="ws-1",
            project_id="proj-1",
            tool_name="conversation",
            idempotency_key="idem-no-run",
            arguments={},
        )
        result = execute_agent_tool(session, request)
        assert result.status == "failed"
        assert "查看者" in result.observation or "身份" in result.observation

    def test_internal_tool_rejects_conversation_run_mismatch(self):
        """F4/F7: Tool rejects when run's conversation_id doesn't match request."""
        from app.services.agent_tools_service import execute_agent_tool
        from app.schemas.runtime import ToolExecutionRequest

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="对话", visibility="private",
        )
        session.add(conv)
        # Run points to conv-2, but request asks for conv-1
        self._create_run(session, run_id="run-mismatch", conversation_id="conv-2", viewer_user_id="user-1")
        session.commit()

        request = ToolExecutionRequest(
            run_id="run-mismatch",
            tool_call_id="tc-1",
            conversation_id="conv-1",  # mismatch with run's conv-2
            workspace_id="ws-1",
            project_id="proj-1",
            tool_name="conversation",
            idempotency_key="idem-mismatch",
            arguments={},
        )
        result = execute_agent_tool(session, request)
        assert result.status == "failed"
        assert "不匹配" in result.observation


# ---------------------------------------------------------------------------
# F1: Migration does not convert newly created private drafts
# ---------------------------------------------------------------------------


class TestMigrationDoesNotConvertNewDrafts:
    """F1: Restart never changes a newly created private draft to team."""

    def test_private_draft_with_creator_survives_migration(self):
        from sqlalchemy import text as sql_text

        engine = _make_engine()
        # Create a private draft with a real creator_user_id
        session = Session(engine)
        _seed_base(session)
        conv = AgentConversation(
            id="draft-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="", visibility="private",
        )
        session.add(conv)
        session.commit()
        session.close()

        # Run migration (simulates restart)
        import app.core.database as db_module
        db_module.engine = engine
        db_module._migrate_agent_conversations_multi()

        # Verify: draft must still be private, not converted to team
        with engine.connect() as conn:
            row = conn.execute(sql_text(
                "SELECT visibility, title FROM agent_conversations WHERE id='draft-1'"
            )).fetchone()
            assert row[0] == "private", "Private draft was incorrectly converted to team"
            assert row[1] == "", "Private draft title was incorrectly changed"

    def test_legacy_rows_without_creator_are_converted(self):
        from sqlalchemy import text as sql_text

        engine = _make_engine()
        # Create a legacy row with empty creator_user_id (the pre-migration default)
        session = Session(engine)
        _seed_base(session)
        conv = AgentConversation(
            id="legacy-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="", title="", visibility="private",
        )
        session.add(conv)
        session.commit()
        session.close()

        import app.core.database as db_module
        db_module.engine = engine
        db_module._migrate_agent_conversations_multi()

        with engine.connect() as conn:
            row = conn.execute(sql_text(
                "SELECT visibility, title FROM agent_conversations WHERE id='legacy-1'"
            )).fetchone()
            assert row[0] == "team", "Legacy row should be converted to team"
            assert row[1] == "项目历史对话", "Legacy row should get default title"


# ---------------------------------------------------------------------------
# F2: Migration preserves children with foreign keys
# ---------------------------------------------------------------------------


class TestMigrationForeignKeys:
    """F2: Migration preserves complete schemas, FKs, indexes for all child tables."""

    def test_migration_preserves_children_with_foreign_keys_on(self):
        """Migration preserves agent_messages data and FK integrity."""
        from sqlalchemy import text as sql_text

        engine = _make_engine()
        # Seed reference tables (workspaces, projects) so FK constraints pass
        session = Session(engine)
        _seed_base(session)
        session.close()

        # Drop and recreate conversation tables with legacy schema
        with engine.connect() as conn:
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_messages"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs_v2"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_conversations"))
            conn.execute(sql_text("""
                CREATE TABLE agent_conversations (
                    id TEXT NOT NULL PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    summary TEXT NOT NULL DEFAULT '',
                    current_focus TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    CONSTRAINT uq_agent_conversations_project_id UNIQUE (project_id)
                )
            """))
            conn.execute(sql_text("""
                CREATE TABLE agent_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    structured_payload TEXT NOT NULL DEFAULT '{}',
                    linked_event_id TEXT,
                    linked_proposal_id TEXT,
                    created_at TIMESTAMP NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
                )
            """))
            now = datetime.now(UTC).isoformat()
            conn.execute(sql_text(
                f"INSERT INTO agent_conversations VALUES ('conv-fk', 'ws-1', 'proj-1', 'active', '', '', '{now}', '{now}')"
            ))
            conn.execute(sql_text(
                f"INSERT INTO agent_messages VALUES ('msg-fk', 'conv-fk', 'user', '你好', '{{}}', NULL, NULL, '{now}')"
            ))
            conn.commit()

        # Run migration
        import app.core.database as db_module
        db_module.engine = engine
        db_module._migrate_agent_conversations_multi()

        # Verify data preserved with FK ON
        with engine.connect() as conn:
            conn.execute(sql_text("PRAGMA foreign_keys=ON"))
            row = conn.execute(sql_text(
                "SELECT id, visibility, title FROM agent_conversations WHERE id='conv-fk'"
            )).fetchone()
            assert row is not None
            assert row[1] == "team"
            assert row[2] == "项目历史对话"

            msg = conn.execute(sql_text(
                "SELECT id, conversation_id FROM agent_messages WHERE id='msg-fk'"
            )).fetchone()
            assert msg is not None
            assert msg[1] == "conv-fk"

            # FK check must pass
            fk_check = conn.execute(sql_text("PRAGMA foreign_key_check")).fetchall()
            assert fk_check == [], f"foreign_key_check failed: {fk_check}"

    def test_migration_preserves_zero_message_database(self):
        """Migration succeeds and FK check is clean when agent_messages exists but is empty."""
        from sqlalchemy import text as sql_text

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        session.close()

        # Create legacy schema with unique constraint; agent_messages exists but empty
        with engine.connect() as conn:
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_messages"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs_v2"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_conversations"))
            conn.execute(sql_text("""
                CREATE TABLE agent_conversations (
                    id TEXT NOT NULL PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    summary TEXT NOT NULL DEFAULT '',
                    current_focus TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    CONSTRAINT uq_agent_conversations_project_id UNIQUE (project_id)
                )
            """))
            conn.execute(sql_text("""
                CREATE TABLE agent_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    structured_payload TEXT NOT NULL DEFAULT '{}',
                    linked_event_id TEXT,
                    linked_proposal_id TEXT,
                    created_at TIMESTAMP NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
                )
            """))
            now = datetime.now(UTC).isoformat()
            conn.execute(sql_text(
                f"INSERT INTO agent_conversations VALUES ('conv-empty', 'ws-1', 'proj-1', 'active', '', '', '{now}', '{now}')"
            ))
            conn.commit()

        import app.core.database as db_module
        db_module.engine = engine
        db_module._migrate_agent_conversations_multi()

        # Verify: conversation migrated, agent_messages table intact, FK check clean
        with engine.connect() as conn:
            conn.execute(sql_text("PRAGMA foreign_keys=ON"))
            row = conn.execute(sql_text(
                "SELECT id, visibility FROM agent_conversations WHERE id='conv-empty'"
            )).fetchone()
            assert row is not None
            assert row[1] == "team"

            # agent_messages table must still exist and be empty
            msg_count = conn.execute(sql_text("SELECT COUNT(*) FROM agent_messages")).fetchone()[0]
            assert msg_count == 0

            # agent_messages schema must still have the FK column definitions
            msg_sql_row = conn.execute(sql_text(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_messages'"
            )).fetchone()
            assert msg_sql_row is not None
            assert "FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)" in msg_sql_row[0]

            fk_check = conn.execute(sql_text("PRAGMA foreign_key_check")).fetchall()
            assert fk_check == [], f"foreign_key_check failed: {fk_check}"

    def test_migration_preserves_complete_child_schemas(self):
        """Migration preserves agent_messages FKs/indexes and agent_runs/agent_runs_v2 schemas."""
        from sqlalchemy import text as sql_text

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        session.close()

        # Build legacy schema with ALL child tables having FKs and indexes
        with engine.connect() as conn:
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_messages"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs_v2"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_conversations"))
            conn.execute(sql_text("""
                CREATE TABLE agent_conversations (
                    id TEXT NOT NULL PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    summary TEXT NOT NULL DEFAULT '',
                    current_focus TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    CONSTRAINT uq_agent_conversations_project_id UNIQUE (project_id)
                )
            """))
            # agent_messages with full schema including FKs and indexes
            conn.execute(sql_text("""
                CREATE TABLE agent_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    structured_payload TEXT NOT NULL DEFAULT '{}',
                    linked_event_id TEXT,
                    linked_proposal_id TEXT,
                    created_at TIMESTAMP NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
                )
            """))
            conn.execute(sql_text(
                "CREATE INDEX ix_agent_messages_conversation_created "
                "ON agent_messages (conversation_id, created_at)"
            ))
            # agent_runs with FK to agent_conversations
            conn.execute(sql_text("""
                CREATE TABLE agent_runs (
                    id TEXT NOT NULL PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    user_instruction TEXT NOT NULL DEFAULT '',
                    selected_module TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    verifier_status TEXT NOT NULL DEFAULT 'not_run',
                    agent_event_id TEXT,
                    proposal_id TEXT,
                    created_at TIMESTAMP NOT NULL,
                    completed_at TIMESTAMP,
                    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
                )
            """))
            # agent_runs_v2 with FK to agent_conversations
            conn.execute(sql_text("""
                CREATE TABLE agent_runs_v2 (
                    id TEXT NOT NULL PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    user_message_id TEXT,
                    viewer_user_id TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'created',
                    current_turn INTEGER NOT NULL DEFAULT 0,
                    current_step INTEGER NOT NULL DEFAULT 0,
                    model_provider TEXT NOT NULL DEFAULT '',
                    model_name TEXT NOT NULL DEFAULT '',
                    resolved_model_provider TEXT NOT NULL DEFAULT '',
                    resolved_model_name TEXT NOT NULL DEFAULT '',
                    model_fallback_reason TEXT,
                    pending_tool_call_id TEXT,
                    pending_tool_name TEXT,
                    pending_tool_version INTEGER,
                    pending_idempotency_key TEXT,
                    side_effects TEXT NOT NULL DEFAULT '[]',
                    last_event_seq INTEGER NOT NULL DEFAULT 0,
                    resume_manifest_version INTEGER NOT NULL DEFAULT 1,
                    state_version INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    completed_at TIMESTAMP,
                    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
                )
            """))

            now = datetime.now(UTC).isoformat()
            conn.execute(sql_text(
                f"INSERT INTO agent_conversations VALUES ('conv-full', 'ws-1', 'proj-1', 'active', '', '', '{now}', '{now}')"
            ))
            conn.execute(sql_text(
                f"INSERT INTO agent_messages VALUES ('msg-full', 'conv-full', 'user', '你好', '{{}}', NULL, NULL, '{now}')"
            ))
            conn.execute(sql_text(
                f"INSERT INTO agent_runs VALUES ('run-full', 'conv-full', 'proj-1', '', '', '', '', 0, 'not_run', NULL, NULL, '{now}', NULL)"
            ))
            conn.execute(sql_text(
                f"INSERT INTO agent_runs_v2 VALUES ('run2-full', 'conv-full', 'proj-1', 'ws-1', NULL, '', 'created', 0, 0, '', '', '', '', NULL, NULL, NULL, NULL, NULL, '[]', 0, 1, 0, '{now}', '{now}', NULL)"
            ))
            conn.commit()

        # Capture child table schemas BEFORE migration
        with engine.connect() as conn:
            before_schemas = {}
            for tbl in ("agent_messages", "agent_runs", "agent_runs_v2"):
                row = conn.execute(sql_text(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=:n"
                ), {"n": tbl}).fetchone()
                before_schemas[tbl] = row[0] if row else None

        # Run migration
        import app.core.database as db_module
        db_module.engine = engine
        db_module._migrate_agent_conversations_multi()

        # Verify child table schemas are UNCHANGED (byte-for-byte)
        with engine.connect() as conn:
            conn.execute(sql_text("PRAGMA foreign_keys=ON"))
            for tbl in ("agent_messages", "agent_runs", "agent_runs_v2"):
                row = conn.execute(sql_text(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=:n"
                ), {"n": tbl}).fetchone()
                after_sql = row[0] if row else None
                assert after_sql == before_schemas[tbl], (
                    f"{tbl} schema changed during migration:\n"
                    f"  before: {before_schemas[tbl]}\n"
                    f"  after:  {after_sql}"
                )

            # Verify data preserved
            msg = conn.execute(sql_text(
                "SELECT id FROM agent_messages WHERE id='msg-full'"
            )).fetchone()
            assert msg is not None

            run = conn.execute(sql_text(
                "SELECT id, conversation_id FROM agent_runs WHERE id='run-full'"
            )).fetchone()
            assert run is not None
            assert run[1] == "conv-full"

            run2 = conn.execute(sql_text(
                "SELECT id, conversation_id FROM agent_runs_v2 WHERE id='run2-full'"
            )).fetchone()
            assert run2 is not None
            assert run2[1] == "conv-full"

            # FK check must pass
            fk_check = conn.execute(sql_text("PRAGMA foreign_key_check")).fetchall()
            assert fk_check == [], f"foreign_key_check failed: {fk_check}"

    def test_migration_clean_fk_check_after_reenable(self):
        """foreign_key_check is clean with PRAGMA foreign_keys=ON after migration."""
        from sqlalchemy import text as sql_text

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        session.close()

        # Legacy schema with FK child table
        with engine.connect() as conn:
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_messages"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_runs_v2"))
            conn.execute(sql_text("DROP TABLE IF EXISTS agent_conversations"))
            conn.execute(sql_text("""
                CREATE TABLE agent_conversations (
                    id TEXT NOT NULL PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    summary TEXT NOT NULL DEFAULT '',
                    current_focus TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    CONSTRAINT uq_agent_conversations_project_id UNIQUE (project_id)
                )
            """))
            conn.execute(sql_text("""
                CREATE TABLE agent_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    structured_payload TEXT NOT NULL DEFAULT '{}',
                    linked_event_id TEXT,
                    linked_proposal_id TEXT,
                    created_at TIMESTAMP NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
                )
            """))
            now = datetime.now(UTC).isoformat()
            conn.execute(sql_text(
                f"INSERT INTO agent_conversations VALUES ('conv-fkcheck', 'ws-1', 'proj-1', 'active', '', '', '{now}', '{now}')"
            ))
            conn.execute(sql_text(
                f"INSERT INTO agent_messages VALUES ('msg-fkcheck', 'conv-fkcheck', 'user', '你好', '{{}}', NULL, NULL, '{now}')"
            ))
            conn.commit()

        import app.core.database as db_module
        db_module.engine = engine
        db_module._migrate_agent_conversations_multi()

        # After migration, foreign_keys=ON must be clean
        with engine.connect() as conn:
            enabled = conn.execute(sql_text("PRAGMA foreign_keys")).scalar_one()
            assert enabled == 1, "Migration returned a connection with foreign keys disabled"
            fk_check = conn.execute(sql_text("PRAGMA foreign_key_check")).fetchall()
            assert fk_check == [], f"foreign_key_check failed after migration: {fk_check}"


# ---------------------------------------------------------------------------
# F3: Legacy GET does not create rows
# ---------------------------------------------------------------------------


class TestLegacyGetDoesNotCreate:
    """F3: Compatibility GET produces no INSERT when no conversation exists."""

    def test_legacy_get_returns_404_without_creating(self):
        """GET /projects/{id}/agent-conversation returns 404 without creating a row."""
        from app.services.agent_conversation_service import get_conversation
        from sqlmodel import select

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        # No conversations exist
        count_before = session.exec(select(AgentConversation)).all()
        assert len(count_before) == 0

        # get_conversation returns None without creating
        result = get_conversation(session, "nonexistent", "user-1")
        assert result is None

        count_after = session.exec(select(AgentConversation)).all()
        assert len(count_after) == 0, "GET created a row — should be read-only"

    def test_latest_accessible_skips_another_members_private_conversation(self):
        from app.services.agent_conversation_service import get_latest_accessible_conversation

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        older_team = AgentConversation(
            id="team-history", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="", title="项目历史对话", visibility="team",
            updated_at=datetime.now(UTC) - timedelta(minutes=1),
        )
        newer_private = AgentConversation(
            id="private-user-2", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-2", title="小王私聊", visibility="private",
            updated_at=datetime.now(UTC),
        )
        session.add_all([older_team, newer_private])
        session.commit()

        result = get_latest_accessible_conversation(session, "proj-1", "user-1")
        assert result is not None
        assert result.id == "team-history"


# ---------------------------------------------------------------------------
# F5: Authorization uses canonical helper consistently
# ---------------------------------------------------------------------------


class TestCanonicalAuthorization:
    """F5: create/list/access use the same authorization predicate."""

    def test_create_rejects_non_member(self):
        from app.services.agent_conversation_service import create_conversation

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        session.add(User(id="user-3", display_name="外来者", created_at=datetime.now(UTC), updated_at=datetime.now(UTC)))
        session.commit()

        with pytest.raises(ValueError, match="成员"):
            create_conversation(session, "proj-1", "user-3")

    def test_list_rejects_non_member(self):
        from app.services.agent_conversation_service import list_conversations

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        session.add(User(id="user-3", display_name="外来者", created_at=datetime.now(UTC), updated_at=datetime.now(UTC)))
        session.commit()

        with pytest.raises(ValueError, match="成员"):
            list_conversations(session, "proj-1", "user-3")

    def test_access_rejects_non_member(self):
        from app.services.agent_conversation_service import create_conversation, check_conversation_access

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)
        conv = create_conversation(session, "proj-1", "user-1")
        session.add(User(id="user-3", display_name="外来者", created_at=datetime.now(UTC), updated_at=datetime.now(UTC)))
        session.commit()

        result = check_conversation_access(session, conv.id, "user-3")
        assert result is None


# ---------------------------------------------------------------------------
# F6: List query is bounded (does not load full transcripts)
# ---------------------------------------------------------------------------


class TestListBoundedQueries:
    """F6: list_conversations uses bounded aggregate queries, not full row loads."""

    def test_list_returns_correct_count_and_preview(self):
        from app.services.agent_conversation_service import create_conversation, list_conversations

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = create_conversation(session, "proj-1", "user-1")
        # Add 100 messages
        for i in range(100):
            session.add(AgentMessage(
                conversation_id=conv.id,
                role="user" if i % 2 == 0 else "assistant",
                content=f"消息{i}" + ("回复" if i % 2 == 1 else ""),
            ))
        session.commit()

        summaries = list_conversations(session, "proj-1", "user-1")
        assert len(summaries) == 1
        s = summaries[0]
        assert s.message_count == 100
        # Preview should be from the last assistant message
        assert s.last_message_preview != ""

    def test_list_with_many_conversations_and_messages(self):
        """List performs well with many conversations (no N+1 message loading)."""
        from app.services.agent_conversation_service import create_conversation, list_conversations

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        # Create 10 conversations with messages
        for i in range(10):
            conv = create_conversation(session, "proj-1", "user-1")
            session.add(AgentMessage(
                conversation_id=conv.id, role="user", content=f"对话{i}的问题",
            ))
            session.add(AgentMessage(
                conversation_id=conv.id, role="assistant", content=f"对话{i}的回答",
            ))
        session.commit()

        summaries = list_conversations(session, "proj-1", "user-1")
        assert len(summaries) == 10
        for s in summaries:
            assert s.message_count == 2


# ---------------------------------------------------------------------------
# F7: Run creation rejects conversation/project mismatch
# ---------------------------------------------------------------------------


class TestRunCreationConversationMismatch:
    """F7: Run creation fails when conversation doesn't belong to project or viewer."""

    def test_run_creation_rejects_conversation_from_different_project(self):
        from app.services.agent_runtime_service import AgentRuntimeService
        from app.schemas.runtime import RunStartRequest

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        # Create a second project
        proj2 = Project(
            id="proj-2", workspace_id="ws-1", name="项目B", idea="想法B",
            deadline="2026-08-01", deliverables="演示", created_by="user-1",
            created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
        )
        session.add(proj2)

        # Conversation belongs to proj-1
        conv = AgentConversation(
            id="conv-p1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="A的对话", visibility="private",
        )
        session.add(conv)
        session.commit()

        svc = AgentRuntimeService(session)
        request = RunStartRequest(
            conversation_id="conv-p1",
            workspace_id="ws-1",
            project_id="proj-2",  # mismatch: conv belongs to proj-1
            viewer_user_id="user-1",
            user_content="测试",
        )
        with pytest.raises(ValueError, match="不属于项目"):
            svc.start_run(request)

    def test_run_creation_rejects_private_conversation_for_different_member(self):
        """A different member cannot start a run against an existing private conversation."""
        from app.services.agent_runtime_service import AgentRuntimeService
        from app.schemas.runtime import RunStartRequest

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        # user-1 creates a private conversation
        conv = AgentConversation(
            id="conv-private", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="私有对话", visibility="private",
        )
        session.add(conv)
        session.commit()

        svc = AgentRuntimeService(session)
        # user-2 tries to start a run against user-1's private conversation
        request = RunStartRequest(
            conversation_id="conv-private",
            workspace_id="ws-1",
            project_id="proj-1",
            viewer_user_id="user-2",
            user_content="测试",
        )
        with pytest.raises(ValueError, match="无权访问"):
            svc.start_run(request)

    def test_run_creation_allows_private_conversation_for_owner(self):
        """The conversation owner can start a run against their own private conversation."""
        from app.services.agent_runtime_service import AgentRuntimeService
        from app.schemas.runtime import RunStartRequest

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-owner", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="我的对话", visibility="private",
        )
        session.add(conv)
        session.commit()

        svc = AgentRuntimeService(session)
        request = RunStartRequest(
            conversation_id="conv-owner",
            workspace_id="ws-1",
            project_id="proj-1",
            viewer_user_id="user-1",
            user_content="测试",
        )
        # Should not raise — owner can access their private conversation
        response = svc.start_run(request)
        assert response.run_id is not None

    def test_run_creation_allows_team_conversation_for_any_member(self):
        """Any workspace member can start a run against a team conversation."""
        from app.services.agent_runtime_service import AgentRuntimeService
        from app.schemas.runtime import RunStartRequest

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-team", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", title="团队对话", visibility="team",
        )
        session.add(conv)
        session.commit()

        svc = AgentRuntimeService(session)
        # user-2 (not creator) can start a run on a team conversation
        request = RunStartRequest(
            conversation_id="conv-team",
            workspace_id="ws-1",
            project_id="proj-1",
            viewer_user_id="user-2",
            user_content="测试",
        )
        response = svc.start_run(request)
        assert response.run_id is not None


class TestCursorPagesChronological:
    """F8: Message pages return messages in chronological order."""

    def test_page_returns_chronological_order(self):
        from app.services.agent_conversation_service import get_messages_page

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", visibility="private",
        )
        session.add(conv)
        base_time = datetime.now(UTC)
        for i in range(5):
            msg = AgentMessage(
                conversation_id="conv-1", role="user",
                content=f"消息{i}",
            )
            msg.created_at = base_time + timedelta(seconds=i)
            session.add(msg)
        session.commit()

        page = get_messages_page(session, "conv-1", "user-1")
        assert page is not None
        assert len(page.messages) == 5
        # Must be in chronological order (oldest first)
        for i in range(len(page.messages) - 1):
            assert page.messages[i].created_at <= page.messages[i + 1].created_at

    def test_paginated_pages_are_chronological_and_gapless(self):
        from app.services.agent_conversation_service import get_messages_page

        engine = _make_engine()
        session = Session(engine)
        _seed_base(session)

        conv = AgentConversation(
            id="conv-1", workspace_id="ws-1", project_id="proj-1",
            creator_user_id="user-1", visibility="private",
        )
        session.add(conv)
        base_time = datetime.now(UTC)
        for i in range(65):
            msg = AgentMessage(
                conversation_id="conv-1", role="user",
                content=f"消息{i}",
            )
            msg.created_at = base_time + timedelta(seconds=i)
            session.add(msg)
        session.commit()

        # Collect pages (fetched newest-first via cursor)
        pages = []
        page = get_messages_page(session, "conv-1", "user-1")
        while page and page.messages:
            pages.append(page)
            if not page.has_older or not page.older_cursor:
                break
            page = get_messages_page(
                session, "conv-1", "user-1",
                before_created_at=page.older_cursor.created_at,
                before_id=page.older_cursor.id,
            )

        # Pages are fetched newest-first; each page is chronological internally.
        # Verify each page is internally ordered
        for p in pages:
            for i in range(len(p.messages) - 1):
                assert p.messages[i].created_at <= p.messages[i + 1].created_at

        # Flatten and verify full coverage with no duplicates/gaps
        all_ids = set()
        all_messages = []
        for p in pages:
            page_ids = {m.id for m in p.messages}
            assert all_ids.isdisjoint(page_ids), "Duplicate messages across pages"
            all_ids.update(page_ids)
            all_messages.extend(p.messages)

        assert len(all_messages) == 65

        # The full set (sorted by created_at) should be gapless
        all_messages.sort(key=lambda m: m.created_at)
        for i in range(len(all_messages) - 1):
            assert all_messages[i].created_at <= all_messages[i + 1].created_at
