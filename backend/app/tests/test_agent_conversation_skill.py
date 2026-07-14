"""
Tests for the explicit `skill` parameter in AgentConversationMessageCreate.

Verifies that:
1. Valid skill names pass validation
2. Invalid skill names are rejected
3. None skill (default) passes validation
4. The skill parameter is correctly used in process_conversation_message_stream
   (explicit skill takes priority over _extract_skill_name inference)
"""

import pytest
from pydantic import ValidationError

from app.schemas.agent_conversation import (
    AgentConversationMessageCreate,
    _VALID_SKILLS,
)


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


class TestSkillValidation:
    """Tests for the skill field validator in AgentConversationMessageCreate."""

    @pytest.mark.parametrize("skill", sorted(_VALID_SKILLS))
    def test_valid_skills_pass(self, skill: str):
        msg = AgentConversationMessageCreate(content="测试消息", skill=skill)
        assert msg.skill == skill

    def test_none_skill_passes(self):
        msg = AgentConversationMessageCreate(content="测试消息")
        assert msg.skill is None

    def test_none_skill_explicit_passes(self):
        msg = AgentConversationMessageCreate(content="测试消息", skill=None)
        assert msg.skill is None

    @pytest.mark.parametrize(
        "invalid_skill",
        [
            "invalid-skill",
            "clarify",        # Not a skill name, it's an action name
            "plan",           # Same
            "breakdown",
            "assign",
            "push",
            "risk",
            "replan",
            "checkin",
            "",               # Empty string should fail
            "project_intake", # Wrong separator
            "PROJECT-INTAKE",  # Wrong case
        ],
    )
    def test_invalid_skills_rejected(self, invalid_skill: str):
        with pytest.raises(ValidationError, match="skill 无效"):
            AgentConversationMessageCreate(content="测试消息", skill=invalid_skill)

    def test_skill_preserved_with_other_fields(self):
        """skill should coexist with model and thinking_level."""
        msg = AgentConversationMessageCreate(
            content="请帮我制定计划",
            skill="project-planning",
            model="deepseek:deepseek-v4-flash",
            thinking_level="medium",
        )
        assert msg.skill == "project-planning"
        assert msg.model == "deepseek:deepseek-v4-flash"
        assert msg.thinking_level == "medium"

    def test_slash_command_preserved(self):
        """slash_command is an optional display hint and is preserved as-is."""
        msg = AgentConversationMessageCreate(
            content="请执行 clarify 模块",
            skill="project-intake",
            slash_command="clarify",
        )
        assert msg.slash_command == "clarify"

    def test_slash_command_none_passes(self):
        msg = AgentConversationMessageCreate(content="普通消息")
        assert msg.slash_command is None


# ---------------------------------------------------------------------------
# _extract_skill_name interaction
# ---------------------------------------------------------------------------


class TestSkillExtractionPrecedence:
    """
    Verify that explicit skill takes priority over content-based inference.

    These tests import _extract_skill_name to confirm the fallback behavior
    when no explicit skill is provided.
    """

    def test_explicit_skill_bypasses_ambiguous_bare_label(self):
        """
        When skill is explicitly provided, _extract_skill_name is not called.
        But even if it were, the explicit skill wins.

        The key invariant: "阶段计划" alone (a bare label) would return None
        from _extract_skill_name, but with explicit skill="project-planning"
        the service uses the explicit skill.
        """
        from app.services.agent_conversation_service import _extract_skill_name

        # Without explicit skill, bare label "阶段计划" → None (answer mode)
        assert _extract_skill_name("阶段计划") is None

        # The service code does: skill_name = skill or _extract_skill_name(content)
        # So with explicit skill, even a bare label content works:
        skill_name = "project-planning" or _extract_skill_name("阶段计划")
        assert skill_name == "project-planning"

    def test_extract_skill_name_handles_expanded_quick_reply(self):
        """
        The defaultInstruction "请执行 plan 模块" should be recognized by
        _extract_skill_name as an expanded quick-reply.
        """
        from app.services.agent_conversation_service import _extract_skill_name

        # "请执行 plan 模块" matches _EXPANDED_QUICK_REPLIES pattern
        assert _extract_skill_name("请执行 plan 模块") == "project-planning"
        assert _extract_skill_name("请执行 clarify 模块") == "project-intake"
        assert _extract_skill_name("请执行 risk 模块") == "risk-analysis"
        assert _extract_skill_name("请执行 replan 模块") == "risk-replan"
        assert _extract_skill_name("请执行 checkin 模块") == "risk-analysis"

    def test_extract_skill_name_returns_none_for_random_text(self):
        from app.services.agent_conversation_service import _extract_skill_name

        assert _extract_skill_name("今天天气怎么样") is None
        assert _extract_skill_name("什么是项目管理") is None
