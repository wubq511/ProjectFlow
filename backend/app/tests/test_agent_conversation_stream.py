"""
Backend streaming contract tests.

Validates Pydantic schemas for StreamContentEvent and StreamToolEvent,
and the SSE event mapping logic in agent_conversation_service.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.schemas.agent_conversation import (
    StreamContentEventSchema,
    StreamErrorEventSchema,
    StreamStatusEventSchema,
    StreamToolStartedSchema,
    StreamToolCompletedSchema,
    StreamToolFailedSchema,
    StreamToolBlockedSchema,
    StreamToolEventSchema,
    StreamDonePayloadSchema,
    StreamDoneExecutionStepSchema,
)


# ---------------------------------------------------------------------------
# StreamContentEventSchema
# ---------------------------------------------------------------------------


class TestStreamContentEventSchema:
    def test_thinking_start_valid(self):
        evt = StreamContentEventSchema(
            kind="thinking", phase="start", content_index=0, message_seq=0
        )
        assert evt.kind == "thinking"
        assert evt.phase == "start"

    def test_thinking_delta_valid(self):
        evt = StreamContentEventSchema(
            kind="thinking", phase="delta", content_index=0, message_seq=0, content="推理增量"
        )
        assert evt.content == "推理增量"

    def test_text_delta_valid(self):
        evt = StreamContentEventSchema(
            kind="text", phase="delta", content_index=1, message_seq=2, content="回答增量"
        )
        assert evt.content == "回答增量"

    def test_delta_without_content_fails(self):
        with pytest.raises(ValidationError, match="content required"):
            StreamContentEventSchema(
                kind="text", phase="delta", content_index=0, message_seq=0
            )


class TestStreamStatusAndErrorSchemas:
    def test_status_requires_controlled_phase_and_message(self):
        status = StreamStatusEventSchema.model_validate(
            {"phase": "executing", "message": "正在执行任务..."}
        )
        assert status.phase == "executing"

    @pytest.mark.parametrize(
        "payload",
        [
            {"phase": "message_start", "message": "内部状态"},
            {"phase": "executing", "message": "正在处理", "project_id": "secret"},
            {"phase": "executing", "message": "正在处理 project_id=secret"},
            {"phase": "executing", "message": "processing"},
            {"phase": "executing"},
        ],
    )
    def test_invalid_status_fails(self, payload):
        with pytest.raises(ValidationError):
            StreamStatusEventSchema.model_validate(payload)

    def test_error_requires_single_message_field(self):
        error = StreamErrorEventSchema.model_validate({"message": "Agent 处理失败，请稍后重试。"})
        assert error.message.startswith("Agent")
        with pytest.raises(ValidationError):
            StreamErrorEventSchema.model_validate({"message": "失败", "debug": "secret"})
        with pytest.raises(ValidationError):
            StreamErrorEventSchema.model_validate({"message": "正在处理 project_id=secret"})


class TestStreamContentEventSchemaValidation:
    def test_start_with_content_fails(self):
        with pytest.raises(ValidationError, match="content only allowed"):
            StreamContentEventSchema(
                kind="thinking", phase="start", content_index=0, message_seq=0, content="extra"
            )

    def test_extra_field_forbidden(self):
        with pytest.raises(ValidationError, match="extra"):
            StreamContentEventSchema(
                kind="text", phase="start", content_index=0, message_seq=0, unexpected_field="x"
            )

    def test_negative_content_index_fails(self):
        with pytest.raises(ValidationError):
            StreamContentEventSchema(
                kind="text", phase="start", content_index=-1, message_seq=0
            )

    def test_negative_message_seq_fails(self):
        with pytest.raises(ValidationError):
            StreamContentEventSchema(
                kind="text", phase="start", content_index=0, message_seq=-1
            )

    def test_strict_int_coercion_fails(self):
        """strict=True means string '0' should not be coerced to int 0."""
        with pytest.raises(ValidationError):
            StreamContentEventSchema(
                kind="text", phase="start", content_index="0", message_seq=0  # type: ignore
            )


# ---------------------------------------------------------------------------
# StreamToolEventSchema (discriminated union)
# ---------------------------------------------------------------------------


class TestStreamToolStartedSchema:
    def test_valid(self):
        evt = StreamToolStartedSchema(
            phase="started", tool_call_id="tc1", tool_name="get_project_state", label="获取项目状态"
        )
        assert evt.phase == "started"

    def test_extra_field_forbidden(self):
        with pytest.raises(ValidationError, match="extra"):
            StreamToolStartedSchema(
                phase="started", tool_call_id="tc1", tool_name="t", label="l", extra="x"
            )

    def test_empty_tool_call_id_fails(self):
        with pytest.raises(ValidationError):
            StreamToolStartedSchema(
                phase="started", tool_call_id="", tool_name="t", label="l"
            )


class TestStreamToolCompletedSchema:
    def test_valid(self):
        evt = StreamToolCompletedSchema(
            phase="completed", tool_call_id="tc1", tool_name="get_project_state"
        )
        assert evt.phase == "completed"


class TestStreamToolFailedSchema:
    def test_valid(self):
        evt = StreamToolFailedSchema(
            phase="failed", tool_call_id="tc1", tool_name="get_project_state"
        )
        assert evt.phase == "failed"


class TestStreamToolBlockedSchema:
    def test_with_tool_call_id(self):
        evt = StreamToolBlockedSchema(
            phase="blocked", tool_call_id="tc1", tool_name="t", label="策略拦截", event_id="ev1"
        )
        assert evt.tool_call_id == "tc1"

    def test_without_tool_call_id(self):
        """policy_block events don't carry tool_call_id."""
        evt = StreamToolBlockedSchema(
            phase="blocked", label="策略拦截", event_id="ev1"
        )
        assert evt.tool_call_id is None
        assert evt.tool_name is None

    def test_empty_event_id_fails(self):
        with pytest.raises(ValidationError):
            StreamToolBlockedSchema(
                phase="blocked", label="策略拦截", event_id=""
            )


# ---------------------------------------------------------------------------
# StreamToolEventSchema RootModel (model_validate works)
# ---------------------------------------------------------------------------


class TestStreamToolEventSchemaRootModel:
    """Verify that RootModel-based StreamToolEventSchema has model_validate."""

    def test_model_validate_started(self):
        data = {"phase": "started", "tool_call_id": "tc1", "tool_name": "get_project_state", "label": "获取项目状态"}
        evt = StreamToolEventSchema.model_validate(data)
        assert evt.root.phase == "started"
        assert evt.root.tool_call_id == "tc1"

    def test_model_validate_completed(self):
        data = {"phase": "completed", "tool_call_id": "tc1", "tool_name": "get_project_state"}
        evt = StreamToolEventSchema.model_validate(data)
        assert evt.root.phase == "completed"

    def test_model_validate_failed(self):
        data = {"phase": "failed", "tool_call_id": "tc1", "tool_name": "get_project_state"}
        evt = StreamToolEventSchema.model_validate(data)
        assert evt.root.phase == "failed"

    def test_model_validate_blocked_with_call_id(self):
        data = {"phase": "blocked", "tool_call_id": "tc1", "tool_name": "t", "label": "策略拦截", "event_id": "ev1"}
        evt = StreamToolEventSchema.model_validate(data)
        assert evt.root.phase == "blocked"
        assert evt.root.tool_call_id == "tc1"

    def test_model_validate_blocked_without_call_id(self):
        data = {"phase": "blocked", "label": "策略拦截", "event_id": "ev1"}
        evt = StreamToolEventSchema.model_validate(data)
        assert evt.root.phase == "blocked"
        assert evt.root.tool_call_id is None

    def test_model_validate_invalid_phase_fails(self):
        with pytest.raises(ValidationError):
            StreamToolEventSchema.model_validate({"phase": "unknown"})

    def test_model_dump_roundtrip(self):
        data = {"phase": "started", "tool_call_id": "tc1", "tool_name": "get_project_state", "label": "获取项目状态"}
        evt = StreamToolEventSchema.model_validate(data)
        dumped = evt.model_dump(mode="json")
        assert dumped["phase"] == "started"
        assert dumped["tool_call_id"] == "tc1"


# ---------------------------------------------------------------------------
# SSE event mapping
# ---------------------------------------------------------------------------


class TestSSEEventMapping:
    """Test that the service layer correctly maps SSE events."""

    def test_sse_helper_format(self):
        from app.services.agent_conversation_service import _sse_event

        result = _sse_event("content", {"kind": "text", "phase": "start", "content_index": 0, "message_seq": 0})
        assert result.startswith("event: content\n")
        assert '"kind": "text"' in result
        assert result.endswith("\n\n")

    def test_sse_disconnect_event(self):
        from app.services.agent_conversation_service import _sse_event

        result = _sse_event("disconnect", {"reason": "连接意外中断，可重试"})
        assert "event: disconnect\n" in result
        assert "连接意外中断" in result


# ---------------------------------------------------------------------------
# StreamDonePayloadSchema
# ---------------------------------------------------------------------------


class TestStreamDoneExecutionStepSchema:
    def test_valid_step(self):
        step = StreamDoneExecutionStepSchema(
            tool_name="get_project_state", tool_call_id="tc1", status="completed", label="获取项目状态"
        )
        assert step.status == "completed"

    def test_blocked_step_without_call_id(self):
        step = StreamDoneExecutionStepSchema(
            tool_name="工具", status="blocked", label="策略拦截"
        )
        assert step.tool_call_id is None
        assert step.status == "blocked"

    def test_invalid_status_fails(self):
        with pytest.raises(ValidationError):
            StreamDoneExecutionStepSchema(
                tool_name="t", status="pending", label="l"
            )

    def test_extra_field_forbidden(self):
        with pytest.raises(ValidationError, match="extra"):
            StreamDoneExecutionStepSchema(
                tool_name="t", status="started", label="l", extra="x"
            )


class TestStreamDonePayloadSchema:
    def test_valid_payload_with_run_id(self):
        payload = StreamDonePayloadSchema(
            run_id="run-abc",
            status="completed",
            final_content="已生成规划",
            thinking_content="分析中...",
            execution_steps=[
                {"tool_name": "get_project_state", "tool_call_id": "tc1", "status": "completed", "label": "获取项目状态"},
            ],
        )
        assert payload.run_id == "run-abc"
        assert payload.status == "completed"
        assert payload.final_content == "已生成规划"
        assert len(payload.execution_steps) == 1

    def test_minimal_payload_with_run_id_and_content(self):
        """run_id and final_content are required."""
        payload = StreamDonePayloadSchema(run_id="run-1", status="completed", final_content="回答")
        assert payload.status == "completed"
        assert payload.final_content == "回答"
        assert payload.thinking_content == ""
        assert payload.execution_steps == []


class _FakeSidecarResponse:
    def __init__(self, wire: str, status_code: int = 200):
        self.wire = wire
        self.status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def iter_text(self):
        midpoint = max(1, len(self.wire) // 2)
        yield self.wire[:midpoint]
        yield self.wire[midpoint:]

    def read(self):
        return self.wire.encode()


class TestConversationStreamProxyIntegration:
    @staticmethod
    def _session_with_conversation():
        from app.models import Project
        from app.models.agent_conversation import AgentConversation

        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        SQLModel.metadata.create_all(engine)
        session = Session(engine)
        project = Project(
            id="project-1", workspace_id="workspace-1", name="项目", idea="想法",
            deadline="2026-08-01", deliverables="演示", created_by="user-1",
        )
        conversation = AgentConversation(
            id="conversation-1", workspace_id="workspace-1", project_id=project.id,
        )
        session.add(project)
        session.add(conversation)
        session.commit()
        return session, conversation

    def test_real_proxy_validates_events_and_persists_only_typed_answer(self, monkeypatch):
        from app.models.agent_conversation import AgentMessage
        from app.services import agent_conversation_service as service

        wire = "".join(
            [
                service._sse_event("status", {"phase": "message_start", "message": "内部 project_id=1"}),
                service._sse_event("token", {"content": "不应进入回答"}),
                service._sse_event("content", {"kind": "text", "phase": "delta", "content_index": 0, "message_seq": 1, "content": "安全回答"}),
                service._sse_event("done", {"run_id": "run-1", "status": "completed", "final_content": "安全回答"}),
            ]
        )
        session, conversation = self._session_with_conversation()
        monkeypatch.setattr(service, "get_workspace_state", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(service.httpx, "stream", lambda *_args, **_kwargs: _FakeSidecarResponse(wire))
        try:
            output = "".join(service.process_conversation_message_stream(session, conversation.id, "问题"))
            messages = session.exec(select(AgentMessage).where(AgentMessage.conversation_id == conversation.id)).all()
        finally:
            session.close()

        assert "message_start" not in output
        assert "不应进入回答" not in output
        assert "event: done" in output
        assert [message.content for message in messages] == ["问题", "安全回答"]

    def test_whitespace_done_returns_error_without_assistant_message(self, monkeypatch):
        from app.models.agent_conversation import AgentMessage
        from app.services import agent_conversation_service as service

        wire = service._sse_event(
            "done",
            {"run_id": "run-empty", "status": "completed", "final_content": "   \n"},
        )
        session, conversation = self._session_with_conversation()
        monkeypatch.setattr(service, "get_workspace_state", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(service.httpx, "stream", lambda *_args, **_kwargs: _FakeSidecarResponse(wire))
        try:
            output = "".join(service.process_conversation_message_stream(session, conversation.id, "问题"))
            messages = session.exec(select(AgentMessage).where(AgentMessage.conversation_id == conversation.id)).all()
        finally:
            session.close()

        assert "event: error" in output
        assert "未生成有效回答" in output
        assert [message.role for message in messages] == ["user"]

    def test_whitespace_done_uses_validated_text_delta_fallback(self, monkeypatch):
        from app.models.agent_conversation import AgentMessage
        from app.services import agent_conversation_service as service

        wire = "".join(
            [
                service._sse_event("content", {"kind": "text", "phase": "delta", "content_index": 0, "message_seq": 1, "content": "流式回答"}),
                service._sse_event("done", {"run_id": "run-fallback", "status": "completed", "final_content": "  \n"}),
            ]
        )
        session, conversation = self._session_with_conversation()
        monkeypatch.setattr(service, "get_workspace_state", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(service.httpx, "stream", lambda *_args, **_kwargs: _FakeSidecarResponse(wire))
        try:
            output = "".join(service.process_conversation_message_stream(session, conversation.id, "问题"))
            messages = session.exec(select(AgentMessage).where(AgentMessage.conversation_id == conversation.id)).all()
        finally:
            session.close()

        assert "event: done" in output
        assert [message.content for message in messages] == ["问题", "流式回答"]


class TestStreamDonePayloadSchemaValidation:
    def test_shared_sidecar_fixture_validates(self):
        fixture_path = Path(__file__).parents[3] / "tests" / "fixtures" / "stream-events.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        done_payload = next(event["data"] for event in fixture["events"] if event["event"] == "done")
        validated = StreamDonePayloadSchema.model_validate(done_payload)
        assert validated.run_id == "run-1"

    def test_missing_final_content_fails(self):
        """final_content is required — no default."""
        with pytest.raises(ValidationError):
            StreamDonePayloadSchema(run_id="run-1", status="completed")

    def test_missing_status_fails(self):
        with pytest.raises(ValidationError):
            StreamDonePayloadSchema(run_id="run-1", final_content="回答")

    def test_missing_run_id_fails(self):
        with pytest.raises(ValidationError):
            StreamDonePayloadSchema(status="completed", final_content="x")

    def test_invalid_status_fails(self):
        with pytest.raises(ValidationError):
            StreamDonePayloadSchema(run_id="r1", status="failed")

    def test_invalid_step_in_payload_fails(self):
        with pytest.raises(ValidationError):
            StreamDonePayloadSchema(
                run_id="r1",
                status="completed",
                final_content="x",
                execution_steps=[
                    {"tool_name": "t", "status": "invalid_status", "label": "l"},
                ],
            )

    def test_extra_field_forbidden(self):
        with pytest.raises(ValidationError, match="extra"):
            StreamDonePayloadSchema(
                run_id="r1",
                status="completed",
                final_content="x",
                unexpected_field="y",
            )

    def test_model_validate_from_sidecar_wire_format(self):
        """Simulate the exact payload produced by sidecar buildDonePayload."""
        data = {
            "run_id": "run-xyz",
            "status": "completed",
            "final_content": "回答",
            "thinking_content": "思考",
            "execution_steps": [
                {"tool_name": "t", "status": "started", "label": "l"},
            ],
        }
        payload = StreamDonePayloadSchema.model_validate(data)
        assert payload.run_id == "run-xyz"
        assert payload.final_content == "回答"
        assert payload.execution_steps[0].tool_name == "t"

    def test_sidecar_payload_without_optional_fields(self):
        """Sidecar omits thinking_content and execution_steps when empty."""
        data = {
            "run_id": "run-abc",
            "status": "completed",
            "final_content": "直接回答",
        }
        payload = StreamDonePayloadSchema.model_validate(data)
        assert payload.thinking_content == ""
        assert payload.execution_steps == []


# ---------------------------------------------------------------------------
# Narrow action-to-Skill mapping
# ---------------------------------------------------------------------------


class TestExtractSkillName:
    """Test _extract_skill_name with precedence-based matching."""

    # ── Exact quick-reply phrases (precedence 1) ────────────────────────

    def test_exact_quick_reply_phrases(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("生成下一步行动卡") == "project-status"
        assert _extract_skill_name("分析当前风险") == "risk-analysis"
        assert _extract_skill_name("根据签到调整计划") == "risk-replan"
        assert _extract_skill_name("根据成员情况推荐分工") == "assignment-planning"
        assert _extract_skill_name("把当前阶段拆成任务") == "task-breakdown"
        assert _extract_skill_name("按三周节奏生成阶段计划") == "project-planning"
        assert _extract_skill_name("先帮我澄清方向") == "project-intake"

    # ── Expanded quick-reply instructions (precedence 2) ────────────────

    def test_expanded_quick_reply_instructions(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("请执行 risk 模块：分析当前风险。用户点击了快捷回复") == "risk-analysis"
        assert _extract_skill_name("请执行 replan 模块：根据签到结果调整项目计划") == "risk-replan"
        assert _extract_skill_name("请执行 plan 模块：按三周节奏生成阶段计划") == "project-planning"
        assert _extract_skill_name("请执行 breakdown 模块：把当前阶段拆成可执行任务") == "task-breakdown"
        assert _extract_skill_name("请执行 assign 模块：根据成员情况推荐分工") == "assignment-planning"
        assert _extract_skill_name("请执行 clarify 模块：澄清项目方向") == "project-intake"
        assert _extract_skill_name("请执行 push 模块：生成下一步行动卡") == "project-status"

    # ── Explicit request marker + action (precedence 3) ─────────────────

    def test_request_marker_plus_action_maps_to_skill(self):
        """请/帮我/麻烦 + action object → action despite question syntax."""
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("请帮我检查项目风险") == "risk-analysis"
        assert _extract_skill_name("可以帮我制定计划吗？") == "project-planning"
        assert _extract_skill_name("能不能帮我拆解任务？") == "task-breakdown"
        assert _extract_skill_name("请分析一下当前风险好吗？") == "risk-analysis"
        assert _extract_skill_name("麻烦帮我分配一下成员") == "assignment-planning"
        assert _extract_skill_name("请帮我澄清一下方向") == "project-intake"

    # ── Risk analysis action mapping ────────────────────────────────────

    def test_risk_analysis_maps_to_risk_analysis_skill(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("分析当前风险") == "risk-analysis"
        assert _extract_skill_name("请帮我检查项目风险") == "risk-analysis"
        assert _extract_skill_name("请分析一下当前风险好吗？") == "risk-analysis"

    # ── Question-only markers → answer mode (precedence 4) ──────────────

    def test_risk_questions_stay_answer_mode(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("当前有哪些风险？") is None
        assert _extract_skill_name("风险等级怎么划分") is None

    def test_delay_questions_stay_answer_mode(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("这个任务为什么延期？") is None
        assert _extract_skill_name("延期了怎么办") is None

    def test_blocker_questions_stay_answer_mode(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("什么是阻塞") is None
        assert _extract_skill_name("当前有哪些阻塞项") is None

    def test_checkin_questions_stay_answer_mode(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("签到是什么意思") is None
        assert _extract_skill_name("签到有什么用") is None

    def test_assignment_questions_stay_answer_mode(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("如何理解团队分工") is None
        assert _extract_skill_name("分工的依据是什么") is None

    def test_plan_questions_stay_answer_mode(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("阶段规划依据是什么") is None
        assert _extract_skill_name("如何制定计划") is None

    def test_clarification_questions_stay_answer_mode(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("方向澄清是什么") is None
        assert _extract_skill_name("为什么要先澄清方向") is None

    # ── Bare domain vocabulary → answer mode (no action verb) ───────────

    def test_bare_domain_words_stay_answer_mode(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("项目遇到阻塞了") is None
        assert _extract_skill_name("延期了") is None
        for label in ("方向澄清", "阶段计划", "任务拆解", "推荐分工", "风险分析", "签到分析"):
            assert _extract_skill_name(label) is None

        assert _extract_skill_name("请帮我澄清方向") == "project-intake"
        assert _extract_skill_name("请帮我拆解任务") == "task-breakdown"
        assert _extract_skill_name("请分析项目风险") == "risk-analysis"

    # ── General content → answer mode ───────────────────────────────────

    def test_general_content_returns_none(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("") is None
        assert _extract_skill_name("你好") is None
        assert _extract_skill_name("今天天气不错") is None
        assert _extract_skill_name("这个项目的核心价值是什么") is None


class TestSidecarRequestIncludesSkill:
    """Test that the sidecar request includes the skill name when an intent is matched."""

    @staticmethod
    def _session_with_conversation():
        from app.models import Project
        from app.models.agent_conversation import AgentConversation

        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        SQLModel.metadata.create_all(engine)
        session = Session(engine)
        project = Project(
            id="project-1", workspace_id="workspace-1", name="项目", idea="想法",
            deadline="2026-08-01", deliverables="演示", created_by="user-1",
        )
        conversation = AgentConversation(
            id="conversation-1", workspace_id="workspace-1", project_id=project.id,
        )
        session.add(project)
        session.add(conversation)
        session.commit()
        return session, conversation

    def test_action_intent_passes_skill_to_sidecar(self, monkeypatch):
        """When user sends an action intent, skill name should be in sidecar request."""
        from app.services import agent_conversation_service as service

        captured_requests = []

        class _CaptureSidecarResponse:
            status_code = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_text(self):
                yield service._sse_event("done", {"run_id": "run-1", "status": "completed", "final_content": "回答"})
                return

            def read(self):
                return b""

        def capturing_stream(method, url, json=None, **kwargs):
            captured_requests.append(json)
            return _CaptureSidecarResponse()

        session, conversation = self._session_with_conversation()
        monkeypatch.setattr(service, "get_workspace_state", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(service.httpx, "stream", capturing_stream)
        try:
            "".join(service.process_conversation_message_stream(session, conversation.id, "帮我制定计划"))
        finally:
            session.close()

        assert len(captured_requests) == 1
        assert captured_requests[0]["runtime_config"]["skill"] == "project-planning"

    def test_general_question_omits_skill_from_sidecar(self, monkeypatch):
        """When user sends a general question, no skill should be in sidecar request."""
        from app.services import agent_conversation_service as service

        captured_requests = []

        class _CaptureSidecarResponse:
            status_code = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_text(self):
                yield service._sse_event("done", {"run_id": "run-1", "status": "completed", "final_content": "回答"})
                return

            def read(self):
                return b""

        def capturing_stream(method, url, json=None, **kwargs):
            captured_requests.append(json)
            return _CaptureSidecarResponse()

        session, conversation = self._session_with_conversation()
        monkeypatch.setattr(service, "get_workspace_state", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(service.httpx, "stream", capturing_stream)
        try:
            "".join(service.process_conversation_message_stream(session, conversation.id, "项目进展如何？"))
        finally:
            session.close()

        assert len(captured_requests) == 1
        assert "skill" not in captured_requests[0]["runtime_config"]


class TestRecentMessagesExcludesCurrent:
    """Test that recent_messages in the sidecar request excludes the just-persisted current user message."""

    @staticmethod
    def _session_with_conversation():
        from app.models import Project
        from app.models.agent_conversation import AgentConversation

        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        SQLModel.metadata.create_all(engine)
        session = Session(engine)
        project = Project(
            id="project-1", workspace_id="workspace-1", name="项目", idea="想法",
            deadline="2026-08-01", deliverables="演示", created_by="user-1",
        )
        conversation = AgentConversation(
            id="conversation-1", workspace_id="workspace-1", project_id=project.id,
        )
        session.add(project)
        session.add(conversation)
        session.commit()
        return session, conversation

    def test_recent_messages_excludes_current_user_message(self, monkeypatch):
        """The current user message must NOT appear in recent_messages."""
        from app.models.agent_conversation import AgentMessage
        from app.services import agent_conversation_service as service

        captured_requests = []

        class _CaptureSidecarResponse:
            status_code = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_text(self):
                yield service._sse_event("done", {"run_id": "run-1", "status": "completed", "final_content": "回答"})

            def read(self):
                return b""

        def capturing_stream(method, url, json=None, **kwargs):
            captured_requests.append(json)
            return _CaptureSidecarResponse()

        session, conversation = self._session_with_conversation()

        # Pre-populate a prior user message so there's something in history
        prior_msg = AgentMessage(
            conversation_id=conversation.id,
            role="user",
            content="之前的问题",
        )
        session.add(prior_msg)
        session.commit()

        monkeypatch.setattr(service, "get_workspace_state", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(service.httpx, "stream", capturing_stream)
        try:
            "".join(service.process_conversation_message_stream(session, conversation.id, "当前的问题"))
        finally:
            session.close()

        assert len(captured_requests) == 1
        recent_messages = captured_requests[0]["recent_messages"]
        recent_contents = [msg["content"] for msg in recent_messages]
        # The current message "当前的问题" must NOT be in recent_messages
        assert "当前的问题" not in recent_contents
        # The prior message "之前的问题" should still be present
        assert "之前的问题" in recent_contents

    def test_recent_messages_when_no_prior_messages(self, monkeypatch):
        """When there are no prior messages, recent_messages should be empty."""
        from app.services import agent_conversation_service as service

        captured_requests = []

        class _CaptureSidecarResponse:
            status_code = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_text(self):
                yield service._sse_event("done", {"run_id": "run-1", "status": "completed", "final_content": "回答"})

            def read(self):
                return b""

        def capturing_stream(method, url, json=None, **kwargs):
            captured_requests.append(json)
            return _CaptureSidecarResponse()

        session, conversation = self._session_with_conversation()
        monkeypatch.setattr(service, "get_workspace_state", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(service.httpx, "stream", capturing_stream)
        try:
            "".join(service.process_conversation_message_stream(session, conversation.id, "第一条消息"))
        finally:
            session.close()

        assert len(captured_requests) == 1
        recent_messages = captured_requests[0]["recent_messages"]
        # No prior messages → recent_messages should be empty
        assert recent_messages == []
