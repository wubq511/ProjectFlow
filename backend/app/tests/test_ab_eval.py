"""Tests for the R8 Agent A/B Effect Evaluation Harness.

These tests validate the harness structure, scenario definitions,
deterministic check evaluation, metric computation, and report generation
using the MockAgentRunner. No real model credentials required.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent.memory.ab_eval import (
    ABEvalConfig,
    DirectAPIRunner,
    MockAgentRunner,
    RunOutput,
    ScenarioCheck,
    ScenarioId,
    SCENARIOS,
    SidecarAgentRunner,
    check_compliance_rate,
    compute_full_metrics,
    compute_scenario_metrics,
    detect_hallucinated_memory,
    detect_privacy_leak,
    detect_superseded_contamination,
    evaluate_check,
    evaluate_checks,
    generate_report,
    generate_blind_review_rows,
    run_ab_eval,
    write_scenario_memories,
    _build_prompt,
    GATE_COMPLIANCE_LIFT,
    GATE_HALLUCINATED_RATE,
    GATE_MEMORY_CONTEXT_TOKENS,
    GATE_PRIVACY_LEAK,
    GATE_REJECTION_REDUCTION,
    GATE_SUPERSEDED_CONTAMINATION,
)
from app.models import AgentConversation, AgentMessage, ProjectMemory
from app.services.memory_service import set_memory_engine
from app.agent.memory.ab_eval_cli import build_parser
import app.agent.memory.ab_eval as ab_eval_module
import app.agent.memory.ab_eval_cli as ab_eval_cli_module


@pytest.fixture(name="memory_session")
def memory_session_fixture():
    """Use the real memory writer and FTS index for fixture regression tests."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)
    set_memory_engine(engine)
    with Session(engine) as session:
        yield session
    from app.core.database import engine as default_engine

    set_memory_engine(default_engine)


# ─── Scenario definition tests ────────────────────────────────────────────────


class TestScenarioDefinitions:
    """Validate the 5 scenario definitions are well-formed."""

    def test_exactly_five_scenarios(self):
        assert len(SCENARIOS) == 5

    def test_all_scenario_ids_unique(self):
        ids = [s.scenario_id for s in SCENARIOS]
        assert len(ids) == len(set(ids))

    def test_all_scenario_ids_covered(self):
        expected = {
            ScenarioId.MEMBER_CONSTRAINT,
            ScenarioId.REJECTION_HISTORY,
            ScenarioId.MVP_BOUNDARY,
            ScenarioId.SUPERSEDE,
            ScenarioId.PRIVACY,
        }
        actual = {s.scenario_id for s in SCENARIOS}
        assert actual == expected

    def test_each_scenario_has_user_prompt(self):
        for s in SCENARIOS:
            assert s.user_prompt, f"{s.scenario_id} missing user_prompt"
            assert len(s.user_prompt) >= 5

    def test_each_scenario_has_workspace_state(self):
        for s in SCENARIOS:
            assert s.workspace_state, f"{s.scenario_id} missing workspace_state"
            assert "project" in s.workspace_state

    def test_each_scenario_has_memory_candidates(self):
        for s in SCENARIOS:
            assert s.memory_candidates, f"{s.scenario_id} has no memory_candidates"

    def test_each_scenario_has_b_group_checks(self):
        for s in SCENARIOS:
            if s.scenario_id == ScenarioId.PRIVACY:
                continue
            assert s.b_group_checks, f"{s.scenario_id} has no b_group_checks"

    def test_privacy_scenario_only_checks_universal_visibility_rules(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.PRIVACY)
        assert scenario.b_group_checks == []
        assert scenario.universal_checks

    def test_each_scenario_has_memory_query(self):
        for s in SCENARIOS:
            assert s.memory_query, f"{s.scenario_id} missing memory_query"

    def test_member_constraint_scenario_forbidden_member(self):
        s = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.MEMBER_CONSTRAINT)
        assert any(c.forbidden_member == "小林" for c in s.b_group_checks)

    def test_privacy_scenario_has_private_content(self):
        s = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.PRIVACY)
        assert any(c["visibility"] == "subject_and_owner" for c in s.memory_candidates)

    def test_a_group_workspace_does_not_embed_private_member_constraint(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.MEMBER_CONSTRAINT)
        state_text = json.dumps(scenario.workspace_state, ensure_ascii=False)
        assert "只能晚上和周末工作" not in state_text

    def test_incremental_memory_facts_are_absent_from_a_group_workspace(self):
        boundary = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.MVP_BOUNDARY)
        supersede = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.SUPERSEDE)
        assert "教务系统对接" not in json.dumps(boundary.workspace_state, ensure_ascii=False)
        assert "多校区" not in json.dumps(supersede.workspace_state, ensure_ascii=False)

    def test_member_constraint_has_an_alternative_fastapi_candidate(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.MEMBER_CONSTRAINT)
        qualified = [
            member
            for member in scenario.workspace_state["members"]
            if "FastAPI" in member["skills"]
        ]
        assert len(qualified) >= 2

    def test_boundary_prompt_presents_a_real_temptation_to_expand_scope(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.MVP_BOUNDARY)
        assert "教务系统对接" in scenario.user_prompt

    def test_supersede_check_accepts_latest_direction_paraphrases(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.SUPERSEDE)
        latest_check = next(
            check for check in scenario.b_group_checks if check.check_type == "must_contain"
        )
        assert {"多校区", "跨校区", "多个校区"}.issubset(set(latest_check.patterns))


# ─── Check evaluation tests ───────────────────────────────────────────────────


class TestCheckEvaluation:
    """Test deterministic check evaluation logic."""

    def test_must_not_contain_passes(self):
        check = ScenarioCheck(
            check_type="must_not_contain",
            description="no raw IDs",
            patterns=["user-lin", "user-wang"],
        )
        result = evaluate_check(check, "推荐小林负责后端 API 开发。")
        assert result.passed
        assert result.matched_patterns == []

    def test_must_not_contain_fails(self):
        check = ScenarioCheck(
            check_type="must_not_contain",
            description="no raw IDs",
            patterns=["user-lin"],
        )
        result = evaluate_check(check, "推荐 user-lin 负责后端 API 开发。")
        assert not result.passed
        assert "user-lin" in result.matched_patterns

    def test_must_contain_passes(self):
        check = ScenarioCheck(
            check_type="must_contain",
            description="mention multi-campus",
            patterns=["多校区"],
        )
        result = evaluate_check(check, "项目支持多校区课表。")
        assert result.passed
        assert "多校区" in result.matched_patterns

    def test_must_contain_fails(self):
        check = ScenarioCheck(
            check_type="must_contain",
            description="mention multi-campus",
            patterns=["多校区"],
        )
        result = evaluate_check(check, "项目支持单校区课表。")
        assert not result.passed

    def test_must_not_assign_passes(self):
        check = ScenarioCheck(
            check_type="must_not_assign",
            description="don't assign to 小林",
            patterns=["小林"],
            forbidden_member="小林",
        )
        result = evaluate_check(check, "推荐小王负责后端 API 开发。小林时间受限。")
        assert result.passed  # mentioning 小林 is ok if not in assignment context

    def test_must_not_assign_fails(self):
        check = ScenarioCheck(
            check_type="must_not_assign",
            description="don't assign to 小林",
            patterns=["小林"],
            forbidden_member="小林",
        )
        result = evaluate_check(check, "推荐小林负责后端 API 开发。")
        assert not result.passed
        assert any("小林" in p for p in result.matched_patterns)

    def test_must_not_assign_allows_explicit_negative_recommendation(self):
        check = ScenarioCheck(
            check_type="must_not_assign",
            description="don't assign to 小林",
            patterns=["小林"],
            forbidden_member="小林",
        )
        result = evaluate_check(check, "考虑到时间冲突，不推荐小林负责后端 API 开发。")
        assert result.passed

    def test_must_not_assign_allows_rejected_option_in_comparison_table(self):
        check = ScenarioCheck(
            check_type="must_not_assign",
            description="don't assign to 小林",
            patterns=["小林"],
            forbidden_member="小林",
        )
        result = evaluate_check(
            check,
            """| 方案 | 后端 API 开发 | 前端页面开发 | 结论 |
| B | 小王 | 小林 | 小林工作日白天不可用，否决 |
| C | 小林 | 小王 | 小林工作日白天不可用，否决 |

首选方案：后端 API 开发和前端页面开发均由小王负责。""",
        )
        assert result.passed

    def test_must_not_assign_allows_hypothetical_assignment_conflict(self):
        check = ScenarioCheck(
            check_type="must_not_assign",
            description="don't assign to 小林",
            patterns=["小林"],
            forbidden_member="小林",
        )
        result = evaluate_check(
            check,
            "无论将后端还是前端任务分配给 小林，都会直接违反其可用时间约束。",
        )
        assert result.passed

    def test_must_not_assign_allows_async_auxiliary_role(self):
        check = ScenarioCheck(
            check_type="must_not_assign",
            description="don't assign daytime work to 小林",
            patterns=["小林"],
            forbidden_member="小林",
        )
        result = evaluate_check(
            check,
            "后端 API 由小王主负责；小林仅在晚上异步补充单元测试和文档。",
        )
        assert result.passed

    def test_must_not_assign_allows_explicitly_non_sync_followup_work(self):
        check = ScenarioCheck(
            check_type="must_not_assign",
            description="don't assign daytime work to 小林",
            patterns=["小林"],
            forbidden_member="小林",
        )
        result = evaluate_check(
            check,
            "建议将部分非同步环节（如接口文档编写、测试）拆分出来，分配给小林（晚上异步）完成。",
        )
        assert result.passed

    def test_must_not_assign_detects_table_primary_assignment(self):
        check = ScenarioCheck(
            check_type="must_not_assign",
            description="don't assign daytime work to 小林",
            patterns=["小林"],
            forbidden_member="小林",
        )
        result = evaluate_check(
            check,
            "| 后端 API 开发 | 小林（主） | 工作日白天与前端联调 |",
        )
        assert not result.passed

    def test_must_respect_boundary_passes(self):
        check = ScenarioCheck(
            check_type="must_respect_boundary",
            description="no external integrations",
            patterns=["教务系统对接"],
            forbidden_items=["教务系统对接", "移动端推送通知"],
        )
        result = evaluate_check(check, "建议优化课表算法。")
        assert result.passed

    def test_must_respect_boundary_fails(self):
        check = ScenarioCheck(
            check_type="must_respect_boundary",
            description="no external integrations",
            patterns=["教务系统对接"],
            forbidden_items=["教务系统对接", "移动端推送通知"],
        )
        result = evaluate_check(check, "建议增加教务系统对接功能。")
        assert not result.passed
        assert "教务系统对接" in result.matched_patterns

    def test_must_respect_boundary_allows_negative_mention(self):
        check = ScenarioCheck(
            check_type="must_respect_boundary",
            description="no external integrations",
            patterns=["教务系统对接"],
            forbidden_items=["教务系统对接"],
        )
        result = evaluate_check(check, "本阶段不建议教务系统对接，应先完成冲突检测。")
        assert result.passed

    def test_must_respect_boundary_allows_deferred_items(self):
        check = ScenarioCheck(
            check_type="must_respect_boundary",
            description="stay inside MVP",
            patterns=[],
            forbidden_items=["教务系统对接", "移动端推送通知", "多学期课表对比"],
        )
        result = evaluate_check(
            check,
            "本轮不纳入教务系统对接；移动端推送通知和多学期课表对比均延后到 v1.1。",
        )
        assert result.passed

    def test_must_respect_boundary_detects_roadmap_inclusion(self):
        check = ScenarioCheck(
            check_type="must_respect_boundary",
            description="stay inside MVP",
            patterns=[],
            forbidden_items=["教务系统对接", "移动端推送通知", "多学期课表对比"],
        )
        result = evaluate_check(
            check,
            "下一步先完成冲突检测，同时接入教务系统对接能力。",
        )
        assert not result.passed

    def test_rejected_plan_check_detects_all_components_in_first_stage(self):
        check = ScenarioCheck(
            check_type="must_not_repeat_rejected_plan",
            description="do not repeat rejected plan",
            patterns=[],
        )
        result = evaluate_check(
            check,
            "第一阶段同时完成后端 API、前端页面和数据库设计，第二阶段再优化。",
        )
        assert not result.passed

    def test_rejected_plan_check_allows_components_split_across_stages(self):
        check = ScenarioCheck(
            check_type="must_not_repeat_rejected_plan",
            description="do not repeat rejected plan",
            patterns=[],
        )
        result = evaluate_check(
            check,
            "第一阶段完成后端 API；第二阶段开发前端页面；第三阶段优化数据库设计。",
        )
        assert result.passed

    def test_rejected_plan_check_allows_discussion_that_is_explicitly_rejected(self):
        check = ScenarioCheck(
            check_type="must_not_repeat_rejected_plan",
            description="do not repeat rejected plan",
            patterns=[],
        )
        result = evaluate_check(
            check,
            "第一阶段原设想同时做后端 API、前端页面和数据库设计，但该方案范围过大，不应采纳。最终建议第一阶段只完成后端 API。",
        )
        assert result.passed

    def test_unknown_check_type_fails_safe(self):
        check = ScenarioCheck(
            check_type="unknown_type",
            description="unknown",
            patterns=[],
        )
        result = evaluate_check(check, "any text")
        assert not result.passed

    def test_evaluate_checks_multiple(self):
        checks = [
            ScenarioCheck(check_type="must_not_contain", description="no IDs", patterns=["user-lin"]),
            ScenarioCheck(check_type="must_contain", description="has reason", patterns=["理由"]),
        ]
        results = evaluate_checks(checks, "推荐小王负责。理由：经验丰富。")
        assert results[0].passed
        assert results[1].passed

    def test_compliance_rate_all_pass(self):
        checks = [
            ScenarioCheck(check_type="must_not_contain", description="a", patterns=["x"]),
            ScenarioCheck(check_type="must_not_contain", description="b", patterns=["y"]),
        ]
        results = evaluate_checks(checks, "hello world")
        assert check_compliance_rate(results) == 1.0

    def test_compliance_rate_half_pass(self):
        checks = [
            ScenarioCheck(check_type="must_not_contain", description="a", patterns=["x"]),
            ScenarioCheck(check_type="must_not_contain", description="b", patterns=["hello"]),
        ]
        results = evaluate_checks(checks, "hello world")
        assert check_compliance_rate(results) == 0.5


# ─── Detection tests ──────────────────────────────────────────────────────────


class TestDetection:
    """Test hallucinated memory, superseded contamination, and privacy leak detection."""

    def test_hallucinated_memory_no_context_with_reference(self):
        output = "根据历史记忆，小林只能晚上工作。"
        assert detect_hallucinated_memory(output, None) is True

    def test_hallucinated_memory_no_context_no_reference(self):
        output = "推荐小王负责后端 API 开发。"
        assert detect_hallucinated_memory(output, None) is False

    def test_hallucinated_memory_with_context(self):
        output = "根据历史记忆，小林只能晚上工作。"
        context = "小林的约束：只能晚上和周末工作。"
        # With context, referencing memory is not hallucination
        assert detect_hallucinated_memory(output, context) is False

    def test_hallucinated_memory_with_context_defers_semantic_claim_to_review(self):
        assert not detect_hallucinated_memory(
            "根据项目记忆，团队已确认下周停止开发。",
            "项目记忆：当前重点是完成课表生成器。",
        )

    def test_superseded_contamination_detected(self):
        output = "项目方向是只做单校区单学期课表。"
        assert detect_superseded_contamination(output, ["只做单校区单学期"]) is True

    def test_superseded_contamination_not_detected(self):
        output = "项目方向是支持多校区课表。"
        assert detect_superseded_contamination(output, ["只做单校区单学期"]) is False

    def test_privacy_leak_detected(self):
        output = "小林的约束：只能晚上和周末工作，不能分配。"
        assert detect_privacy_leak(output, ["只能晚上和周末工作"]) is True

    def test_privacy_leak_not_detected(self):
        output = "推荐小王负责后端 API 开发。"
        assert detect_privacy_leak(output, ["只能晚上和周末工作"]) is False


# ─── Mock A/B runner tests ────────────────────────────────────────────────────


class TestMockABRunner:
    """Test the A/B evaluation runner with MockAgentRunner."""

    def test_mock_runner_returns_output(self):
        runner = MockAgentRunner()
        text, tokens, latency, error = runner.run(
            user_prompt="test",
            workspace_state={},
            memory_context_text=None,
            scenario_id=ScenarioId.MEMBER_CONSTRAINT.value,
        )
        assert text
        assert tokens > 0
        assert latency > 0
        assert error is None

    def test_mock_runner_records_runs(self):
        runner = MockAgentRunner()
        runner.run(
            user_prompt="test",
            workspace_state={},
            memory_context_text=None,
            scenario_id=ScenarioId.MEMBER_CONSTRAINT.value,
        )
        assert len(runner.runs) == 1
        assert runner.runs[0]["has_memory"] is False

    def test_mock_runner_differs_by_memory(self):
        runner = MockAgentRunner()
        a_text, _, _, _ = runner.run(
            user_prompt="test",
            workspace_state={},
            memory_context_text=None,
            scenario_id=ScenarioId.MEMBER_CONSTRAINT.value,
        )
        b_text, _, _, _ = runner.run(
            user_prompt="test",
            workspace_state={},
            memory_context_text="some memory",
            scenario_id=ScenarioId.MEMBER_CONSTRAINT.value,
        )
        # Mock outputs should differ between A and B
        assert a_text != b_text

    def test_run_ab_eval_returns_correct_counts(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=2, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        # 2 instances × 1 repeat × 5 scenarios = 10 runs per group
        assert len(a_runs) == 10
        assert len(b_runs) == 10

    def test_run_ab_eval_config_total_runs(self):
        config = ABEvalConfig(instances=10, repeats=3)
        # 10 × 3 × 5 × 2 = 300
        assert config.total_runs == 300

    def test_run_ab_eval_groups_labeled(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=1, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        assert all(r.group == "A" for r in a_runs)
        assert all(r.group == "B" for r in b_runs)

    def test_run_ab_eval_a_group_has_no_memory(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=1, repeats=1)
        a_runs, _ = run_ab_eval(runner, config)
        for r in a_runs:
            assert r.memory_context_text is None
            assert r.used_memory_ids == []

    def test_run_ab_eval_all_scenarios_covered(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=1, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        a_ids = {r.scenario_id for r in a_runs}
        b_ids = {r.scenario_id for r in b_runs}
        assert a_ids == {s.scenario_id for s in SCENARIOS}
        assert b_ids == {s.scenario_id for s in SCENARIOS}


# ─── Metric computation tests ─────────────────────────────────────────────────


class TestMetricComputation:
    """Test metric computation with mock outputs."""

    def _make_run(
        self,
        group: str,
        scenario_id: ScenarioId,
        output_text: str,
        memory_text: str | None = None,
    ) -> RunOutput:
        return RunOutput(
            group=group,
            scenario_id=scenario_id,
            instance=0,
            repeat=0,
            output_text=output_text,
            memory_context_text=memory_text,
            used_memory_ids=["mem-1"] if memory_text else [],
            token_count_estimate=len(output_text) // 2,
            latency_ms=100.0,
        )

    def test_member_constraint_b_compliance_higher(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.MEMBER_CONSTRAINT)
        # A group: assigns to 小林 (violates constraint)
        a_runs = [
            self._make_run("A", ScenarioId.MEMBER_CONSTRAINT, "推荐小林负责后端 API 开发。"),
        ]
        # B group: avoids assigning to 小林 (respects constraint)
        b_runs = [
            self._make_run("B", ScenarioId.MEMBER_CONSTRAINT, "推荐小王负责后端 API 开发。小林时间受限。", "memory text"),
        ]
        metrics = compute_scenario_metrics(scenario, a_runs, b_runs)
        assert metrics.b_compliance_rate > metrics.a_compliance_rate
        assert metrics.compliance_lift > 0

    def test_rejection_scenario_rates(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.REJECTION_HISTORY)
        a_runs = [
            self._make_run("A", ScenarioId.REJECTION_HISTORY, "第一阶段包含后端 API、前端页面、数据库设计全部任务。"),
        ]
        b_runs = [
            self._make_run("B", ScenarioId.REJECTION_HISTORY, "第一阶段聚焦课表生成器。", "memory text"),
        ]
        metrics = compute_scenario_metrics(scenario, a_runs, b_runs)
        assert metrics.a_repeated_rejection_rate > 0
        assert metrics.b_repeated_rejection_rate == 0

    def test_boundary_violation_rates(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.MVP_BOUNDARY)
        a_runs = [
            self._make_run("A", ScenarioId.MVP_BOUNDARY, "建议增加教务系统对接功能。"),
        ]
        b_runs = [
            self._make_run("B", ScenarioId.MVP_BOUNDARY, "建议优化课表算法。", "memory text"),
        ]
        metrics = compute_scenario_metrics(scenario, a_runs, b_runs)
        assert metrics.a_boundary_violation_rate > 0
        assert metrics.b_boundary_violation_rate == 0

    def test_superseded_contamination_zero(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.SUPERSEDE)
        b_runs = [
            self._make_run("B", ScenarioId.SUPERSEDE, "项目支持多校区课表。", "memory text"),
        ]
        metrics = compute_scenario_metrics(scenario, [], b_runs)
        assert metrics.superseded_contamination_rate == 0

    def test_superseded_contamination_detected(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.SUPERSEDE)
        b_runs = [
            self._make_run("B", ScenarioId.SUPERSEDE, "项目只做单校区单学期课表。", "memory text"),
        ]
        metrics = compute_scenario_metrics(scenario, [], b_runs)
        assert metrics.superseded_contamination_rate > 0

    def test_privacy_leak_detected(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.PRIVACY)
        a_runs = [
            self._make_run("A", ScenarioId.PRIVACY, "小林只能晚上和周末工作，推荐小王。"),
        ]
        metrics = compute_scenario_metrics(scenario, a_runs, [])
        assert metrics.a_privacy_leak_rate > 0

    def test_privacy_no_leak(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.PRIVACY)
        a_runs = [
            self._make_run("A", ScenarioId.PRIVACY, "推荐小王负责后端 API 开发。"),
        ]
        metrics = compute_scenario_metrics(scenario, a_runs, [])
        assert metrics.a_privacy_leak_rate == 0

    def test_token_overhead_computed(self):
        scenario = SCENARIOS[0]
        a_runs = [
            self._make_run("A", scenario.scenario_id, "short"),
        ]
        b_runs = [
            self._make_run("B", scenario.scenario_id, "longer output with memory context", "mem"),
        ]
        metrics = compute_scenario_metrics(scenario, a_runs, b_runs)
        assert metrics.token_overhead > 0


# ─── Aggregate metrics and gate tests ─────────────────────────────────────────


class TestAggregateMetrics:
    """Test aggregate metric computation and gate evaluation."""

    def test_full_metrics_with_mock_runner(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=2, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        metrics = compute_full_metrics(a_runs, b_runs)
        assert len(metrics.scenario_metrics) == 5
        assert 0.0 <= metrics.overall_compliance_lift <= 1.0

    def test_privacy_scenario_does_not_dilute_decision_compliance_lift(self):
        runner = MockAgentRunner()
        a_runs, b_runs = run_ab_eval(
            runner,
            ABEvalConfig(instances=1, repeats=1),
        )
        metrics = compute_full_metrics(a_runs, b_runs)
        applicable_lifts = [
            metric.compliance_lift
            for metric in metrics.scenario_metrics
            if metric.scenario_id != ScenarioId.PRIVACY
        ]
        assert metrics.overall_compliance_lift == pytest.approx(
            sum(applicable_lifts) / len(applicable_lifts)
        )

    def test_gates_have_all_keys(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=1, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        metrics = compute_full_metrics(a_runs, b_runs)
        expected_keys = {
            "compliance_lift_15pp",
            "rejection_reduction_70pct",
            "superseded_contamination_zero",
            "privacy_leak_zero",
            "hallucinated_rate_1pct",
            "raw_id_leak_zero",
            "memory_context_budget",
        }
        assert set(metrics.gates_passed.keys()) == expected_keys

    def test_mock_runner_passes_privacy_and_superseded_gates(self):
        """MockAgentRunner is designed to produce clean B-group outputs."""
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=3, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        metrics = compute_full_metrics(a_runs, b_runs)
        assert metrics.gates_passed["superseded_contamination_zero"]
        assert not metrics.gates_passed["privacy_leak_zero"]

    def test_gate_thresholds_match_remediation_plan(self):
        assert GATE_COMPLIANCE_LIFT == 0.15
        assert GATE_REJECTION_REDUCTION == 0.70
        assert GATE_SUPERSEDED_CONTAMINATION == 0.0
        assert GATE_PRIVACY_LEAK == 0.0
        assert GATE_HALLUCINATED_RATE == 0.01
        assert GATE_MEMORY_CONTEXT_TOKENS == 2000

    def test_memory_context_budget_gate_fails_for_oversized_injection(self):
        scenario = SCENARIOS[0]
        a_runs = [RunOutput("A", scenario.scenario_id, 0, 0, "ok", None, [], 1, 1.0)]
        b_runs = [
            RunOutput(
                "B", scenario.scenario_id, 0, 0, "ok", "memory", ["mem-1"], 1, 1.0,
                memory_context_token_estimate=GATE_MEMORY_CONTEXT_TOKENS + 1,
            )
        ]

        metrics = compute_full_metrics(a_runs, b_runs, [scenario])

        assert not metrics.gates_passed["memory_context_budget"]

    def test_rejection_gate_fails_without_a_group_rejection_baseline(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.REJECTION_HISTORY)
        a_runs = [
            RunOutput("A", scenario.scenario_id, 0, 0, "第一阶段聚焦核心功能。", None, [], 1, 1.0),
        ]
        b_runs = [
            RunOutput("B", scenario.scenario_id, 0, 0, "第一阶段聚焦核心功能。", "memory", ["mem-1"], 1, 1.0),
        ]

        metrics = compute_full_metrics(a_runs, b_runs, [scenario])

        assert not metrics.gates_passed["rejection_reduction_70pct"]


# ─── Report generation tests ──────────────────────────────────────────────────


class TestReportGeneration:
    """Test Markdown report generation."""

    def test_report_contains_all_sections(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=1, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        metrics = compute_full_metrics(a_runs, b_runs)
        report = generate_report(metrics)

        assert "# ProjectMemory V1 Agent A/B 效果评估报告" in report
        assert "## 总体指标" in report
        assert "## 场景详情" in report
        assert "## 实验方法" in report
        assert "## Gate 定义" in report

    def test_report_contains_all_scenarios(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=1, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        metrics = compute_full_metrics(a_runs, b_runs)
        report = generate_report(metrics)

        for sid in ScenarioId:
            assert f"### {sid.value}" in report

    def test_report_contains_gate_results(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=1, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        metrics = compute_full_metrics(a_runs, b_runs)
        report = generate_report(metrics)

        # Gate results are shown as ✅ or ❌
        assert "✅" in report or "❌" in report

    def test_report_is_valid_markdown(self):
        runner = MockAgentRunner()
        config = ABEvalConfig(instances=1, repeats=1)
        a_runs, b_runs = run_ab_eval(runner, config)
        metrics = compute_full_metrics(a_runs, b_runs)
        report = generate_report(metrics)

        # No unclosed formatting
        lines = report.split("\n")
        for line in lines:
            # Table rows should have consistent pipe count
            if "|" in line:
                pipe_count = line.count("|")
                assert pipe_count >= 2  # at least |...|

    def test_report_does_not_render_double_signed_latency(self):
        runner = MockAgentRunner()
        a_runs, b_runs = run_ab_eval(runner, ABEvalConfig(instances=1, repeats=1))
        metrics = compute_full_metrics(a_runs, b_runs)
        metrics.mean_latency_overhead_ms = -125.0
        metrics.scenario_metrics[0].token_overhead = -8.0

        report = generate_report(metrics)

        assert "+-" not in report
        assert "-125ms" in report
        assert "Token 开销：-8" in report

    def test_direct_report_is_labeled_exploratory_not_release_evidence(self):
        runner = MockAgentRunner()
        a_runs, b_runs = run_ab_eval(runner, ABEvalConfig(instances=1, repeats=1))
        metrics = compute_full_metrics(a_runs, b_runs)

        report = generate_report(metrics, evidence_mode="direct_exploratory")

        assert "Direct API 模型敏感性实验" in report
        assert "不能作为端到端 release evidence" in report


# ─── Universal check tests ────────────────────────────────────────────────────


class TestUniversalChecks:
    """Test that universal checks (no raw IDs, no privacy leak) work correctly."""

    def test_no_scenario_output_contains_raw_ids(self):
        """MockAgentRunner should never produce raw user_id in output."""
        runner = MockAgentRunner()
        for scenario in SCENARIOS:
            for has_mem in [False, True]:
                text, _, _, _ = runner.run(
                    user_prompt=scenario.user_prompt,
                    workspace_state=scenario.workspace_state,
                    memory_context_text="memory" if has_mem else None,
                    scenario_id=scenario.scenario_id.value,
                )
                for uc in scenario.universal_checks:
                    if uc.check_type == "must_not_contain" and "user-" in str(uc.patterns):
                        result = evaluate_check(uc, text)
                        assert result.passed, (
                            f"{scenario.scenario_id} output contains raw ID: "
                            f"{result.matched_patterns}"
                        )

    def test_universal_checks_all_pass_on_mock_output(self):
        runner = MockAgentRunner()
        for scenario in SCENARIOS:
            text, _, _, _ = runner.run(
                user_prompt=scenario.user_prompt,
                workspace_state=scenario.workspace_state,
                memory_context_text="memory",
                scenario_id=scenario.scenario_id.value,
            )
            results = evaluate_checks(scenario.universal_checks, text)
            for r in results:
                assert r.passed, (
                    f"{scenario.scenario_id} universal check failed: "
                    f"{r.check.description} — {r.matched_patterns}"
                )

    def test_raw_id_leak_is_an_independent_release_gate(self):
        scenario = SCENARIOS[0]
        common = dict(
            scenario_id=scenario.scenario_id,
            instance=0,
            repeat=0,
            memory_context_text=None,
            used_memory_ids=[],
            token_count_estimate=10,
            latency_ms=10,
            user_prompt=scenario.user_prompt,
        )
        a_run = RunOutput(group="A", output_text="推荐小王负责。", **common)
        b_run = RunOutput(
            group="B",
            output_text="推荐小王（user-wang）负责。",
            **common,
        )

        metrics = compute_full_metrics([a_run], [b_run], [scenario])

        assert metrics.total_raw_id_leak == 0.5
        assert not metrics.gates_passed["raw_id_leak_zero"]


class TestFixtureAndCliRegression:
    def test_fixture_writer_supersedes_old_direction_with_new_memory(
        self,
        memory_session: Session,
    ):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.SUPERSEDE)

        written_ids = write_scenario_memories(
            memory_session,
            scenario,
            workspace_id="eval-workspace",
            project_id="eval-project",
            owner_user_id="eval-owner",
            member_user_id="eval-member",
        )

        memories = memory_session.exec(
            select(ProjectMemory).where(ProjectMemory.id.in_(written_ids))
        ).all()
        assert len(memories) == 2
        old_memory = next(m for m in memories if "旧方向" in m.content)
        new_memory = next(m for m in memories if "最新方向" in m.content)
        assert old_memory.status == "superseded"
        assert old_memory.superseded_by_memory_id == new_memory.id
        assert new_memory.status == "active"

    def test_fixture_isolation_rejects_memories_from_another_scenario(
        self,
        memory_session: Session,
    ):
        member_scenario = next(
            s for s in SCENARIOS if s.scenario_id == ScenarioId.MEMBER_CONSTRAINT
        )
        privacy_scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.PRIVACY)
        write_scenario_memories(
            memory_session,
            member_scenario,
            workspace_id="eval-workspace",
            project_id="eval-project",
            owner_user_id="eval-owner",
            member_user_id="eval-member",
        )

        validator = getattr(ab_eval_module, "validate_fixture_project_isolation", None)
        assert validator is not None
        with pytest.raises(ValueError, match="dedicated empty project"):
            validator(memory_session, project_id="eval-project", scenario=privacy_scenario)

    def test_fixture_isolation_requires_an_empty_conversation(
        self,
        memory_session: Session,
    ):
        conversation = AgentConversation(
            id="eval-conversation",
            workspace_id="eval-workspace",
            project_id="eval-project",
        )
        memory_session.add(conversation)
        memory_session.add(AgentMessage(
            conversation_id=conversation.id,
            role="user",
            content="pre-existing conversation content",
        ))
        memory_session.commit()

        with pytest.raises(ValueError, match="empty Agent conversation"):
            ab_eval_module.validate_fixture_project_isolation(
                memory_session,
                project_id="eval-project",
                scenario=SCENARIOS[0],
                conversation_id=conversation.id,
            )

    def test_documented_module_cli_exposes_help(self):
        result = subprocess.run(
            [sys.executable, "-m", "app.agent.memory.ab_eval", "--help"],
            capture_output=True,
            text=True,
            check=False,
        )

        assert result.returncode == 0
        assert "ProjectMemory V1 Agent A/B Effect Evaluation" in result.stdout

    def test_direct_cli_reads_secret_from_environment_not_argument_value(self):
        option_strings = {
            option
            for action in build_parser()._actions
            for option in action.option_strings
        }
        assert "--api-key" not in option_strings
        assert "--api-key-env" in option_strings

    def test_mock_cli_succeeds_when_structural_run_completes(self, tmp_path):
        output_path = tmp_path / "mock-report.md"
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "app.agent.memory.ab_eval",
                "--mock",
                "--instances",
                "1",
                "--repeats",
                "1",
                "--output",
                str(output_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        assert result.returncode == 0
        assert output_path.exists()

    def test_cli_runner_modes_are_mutually_exclusive(self):
        with pytest.raises(SystemExit):
            build_parser().parse_args(["--mock", "--direct"])

    def test_release_pilot_requires_ten_variants_and_three_repeats(self):
        validator = getattr(ab_eval_cli_module, "validate_release_pilot_config", None)
        assert validator is not None
        with pytest.raises(ValueError, match="10 variants and 3 repeats"):
            validator(ABEvalConfig(instances=10, repeats=1, scenarios=[SCENARIOS[0]]))

    def test_release_aggregate_requires_exactly_150_paired_trials(self):
        validator = getattr(ab_eval_cli_module, "validate_release_aggregate", None)
        assert validator is not None
        a_runs, b_runs = run_ab_eval(
            MockAgentRunner(),
            ABEvalConfig(instances=10, repeats=3),
        )
        for run in [*a_runs, *b_runs]:
            run.runtime_memory_mode = run.group == "B" and "enabled" or "disabled"
            run.runtime_memory_evidence_verified = True
            run.runtime_memory_injected_count = (
                0
                if run.group == "A" or run.scenario_id == ScenarioId.PRIVACY
                else 1
            )
            if run.scenario_id == ScenarioId.PRIVACY:
                run.privacy_visibility_verified = True

        validator(a_runs, b_runs)
        assert len(a_runs) == 150
        assert len(b_runs) == 150

        with pytest.raises(ValueError, match="30 A and 30 B runs"):
            validator(a_runs[:-1], b_runs)

        active_b_run = next(
            run for run in b_runs if run.scenario_id == ScenarioId.MEMBER_CONSTRAINT
        )
        active_b_run.memory_context_text = None
        with pytest.raises(ValueError, match="B runs require injected memory context"):
            validator(a_runs, b_runs)

    def test_release_bundle_metadata_requires_five_dedicated_projects(self):
        validator = getattr(
            ab_eval_cli_module,
            "validate_release_bundle_metadata",
            None,
        )
        assert validator is not None
        metadata = [
            {
                "evidence_mode": "sidecar_end_to_end",
                "model": "fixed-model",
                "project_id": f"project-{index}",
                "conversation_id": f"conversation-{index}",
                "scenarios": [scenario.scenario_id.value],
            }
            for index, scenario in enumerate(SCENARIOS)
        ]

        validator(metadata)
        metadata[-1]["project_id"] = metadata[0]["project_id"]
        with pytest.raises(ValueError, match="five dedicated projects"):
            validator(metadata)

    def test_release_cli_aggregates_reviews_and_applies_blind_labels(self, tmp_path):
        bundle_paths = []
        for index, scenario in enumerate(SCENARIOS):
            a_runs, b_runs = run_ab_eval(
                MockAgentRunner(),
                ABEvalConfig(instances=10, repeats=3, scenarios=[scenario]),
            )
            for run in [*a_runs, *b_runs]:
                run.runtime_memory_mode = (
                    "enabled" if run.group == "B" else "disabled"
                )
                run.runtime_memory_evidence_verified = True
                run.runtime_memory_injected_count = (
                    0
                    if run.group == "A" or scenario.scenario_id == ScenarioId.PRIVACY
                    else 1
                )
                if scenario.scenario_id == ScenarioId.PRIVACY:
                    run.privacy_visibility_verified = True
            payload = ab_eval_module.serialize_run_bundle(
                a_runs,
                b_runs,
                metadata={
                    "evidence_mode": "sidecar_end_to_end",
                    "model": "fixed-model",
                    "project_id": f"project-{index}",
                    "conversation_id": f"conversation-{index}",
                    "scenarios": [scenario.scenario_id.value],
                },
            )
            bundle_path = tmp_path / f"{scenario.scenario_id.value}.json"
            bundle_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            bundle_paths.append(str(bundle_path))

        review_path = tmp_path / "review.json"
        key_path = tmp_path / "review-key.json"
        preliminary_path = tmp_path / "preliminary.md"
        prepare_result = subprocess.run(
            [
                sys.executable,
                "-m",
                "app.agent.memory.ab_eval",
                "--aggregate-inputs",
                *bundle_paths,
                "--review-output",
                str(review_path),
                "--review-key-output",
                str(key_path),
                "--output",
                str(preliminary_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert prepare_result.returncode == 0, prepare_result.stderr

        review_rows = json.loads(review_path.read_text(encoding="utf-8"))
        review_key = json.loads(key_path.read_text(encoding="utf-8"))
        for row in review_rows:
            group = review_key[row["blind_id"]]["group"]
            scenario_id = ScenarioId(row["scenario_id"])
            if scenario_id != ScenarioId.PRIVACY:
                row["review"]["decision_compliant"] = group == "B"
            if scenario_id == ScenarioId.REJECTION_HISTORY:
                row["review"]["repeats_rejected_plan"] = group == "A"
            row["review"]["hallucinated_memory"] = False
            if scenario_id == ScenarioId.PRIVACY:
                row["review"]["privacy_leak"] = False
        review_path.write_text(
            json.dumps(review_rows, ensure_ascii=False),
            encoding="utf-8",
        )

        final_path = tmp_path / "final.md"
        final_result = subprocess.run(
            [
                sys.executable,
                "-m",
                "app.agent.memory.ab_eval",
                "--aggregate-inputs",
                *bundle_paths,
                "--release-pilot",
                "--reviewed-input",
                str(review_path),
                "--output",
                str(final_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        assert final_result.returncode == 0, final_result.stderr
        final_report = final_path.read_text(encoding="utf-8")
        assert "独立盲审：已完成" in final_report
        assert "150 个 paired trials / 300 次模型执行" in final_report


class TestScenarioVariantsAndReview:
    def test_each_scenario_has_ten_distinct_prompt_variants(self):
        prompt_builder = getattr(ab_eval_module, "build_instance_prompt", None)
        assert prompt_builder is not None
        for scenario in SCENARIOS:
            prompts = {prompt_builder(scenario, index) for index in range(10)}
            assert len(prompts) == 10

    def test_instance_prompts_enforce_read_only_evaluation_boundary(self):
        prompt = ab_eval_module.build_instance_prompt(SCENARIOS[0], 0)

        assert "不要调用任何工具" in prompt
        assert "不要创建或修改提案" in prompt
        assert "不超过 500 字" in prompt
        assert "不要输出任何内部 ID" in prompt

    def test_rejection_scenario_establishes_a_real_baseline(self):
        scenario = next(
            item for item in SCENARIOS if item.scenario_id == ScenarioId.REJECTION_HISTORY
        )

        assert "请按这个初步方案" in scenario.user_prompt
        assert "评估并制定" not in scenario.user_prompt
        assert "若没有明确的项目历史冲突，不要调整范围" in scenario.user_prompt

    def test_runner_uses_distinct_prompt_for_each_instance(self):
        runner = MockAgentRunner()
        scenario = SCENARIOS[0]
        a_runs, _b_runs = run_ab_eval(
            runner,
            ABEvalConfig(instances=10, repeats=1, scenarios=[scenario]),
        )
        a_prompts = [run.user_prompt for run in a_runs]
        assert len(set(a_prompts)) == 10

    def test_runner_counterbalances_group_execution_order(self):
        runner = MockAgentRunner()
        run_ab_eval(
            runner,
            ABEvalConfig(instances=2, repeats=3, scenarios=[SCENARIOS[0]]),
        )

        first_group_has_memory = [run["has_memory"] for run in runner.runs[::2]]
        assert first_group_has_memory.count(False) == 3
        assert first_group_has_memory.count(True) == 3

    def test_blind_review_rows_hide_group_and_memory_context(self):
        review_builder = getattr(ab_eval_module, "generate_blind_review_rows", None)
        assert review_builder is not None
        runner = MockAgentRunner()
        a_runs, b_runs = run_ab_eval(
            runner,
            ABEvalConfig(instances=1, repeats=1, scenarios=[SCENARIOS[0]]),
        )
        rows, key = review_builder(a_runs, b_runs)
        assert len(rows) == 2
        assert len(key) == 2
        assert all(
            "group" not in row
            and "memory_context_text" not in row
            and "instance" not in row
            and "repeat" not in row
            for row in rows
        )
        assert all(row["user_prompt"] and row["review_guide"] for row in rows)

    def test_run_bundle_round_trip_preserves_audit_fields(self):
        serializer = getattr(ab_eval_module, "serialize_run_bundle", None)
        deserializer = getattr(ab_eval_module, "deserialize_run_bundle", None)
        assert serializer is not None
        assert deserializer is not None
        runner = MockAgentRunner()
        a_runs, b_runs = run_ab_eval(
            runner,
            ABEvalConfig(instances=1, repeats=1, scenarios=[SCENARIOS[0]]),
        )

        payload = serializer(
            a_runs,
            b_runs,
            metadata={"model": "test-model", "evidence_mode": "sidecar_end_to_end"},
        )
        restored_a, restored_b, metadata = deserializer(payload)

        assert restored_a[0].output_text == a_runs[0].output_text
        assert restored_b[0].memory_context_text == b_runs[0].memory_context_text
        assert restored_a[0].user_prompt
        assert metadata["model"] == "test-model"

    def test_human_review_labels_override_automatic_compliance(self):
        runner = MockAgentRunner()
        scenario = SCENARIOS[0]
        a_runs, b_runs = run_ab_eval(
            runner,
            ABEvalConfig(instances=1, repeats=1, scenarios=[scenario]),
        )
        rows, _key = generate_blind_review_rows(a_runs, b_runs)
        for row in rows:
            row["review"]["decision_compliant"] = False
            row["review"]["hallucinated_memory"] = False

        metrics = compute_full_metrics(
            a_runs,
            b_runs,
            [scenario],
            human_review_rows=rows,
            human_review_required=True,
        )

        assert metrics.human_review_complete
        assert metrics.scenario_metrics[0].a_compliance_rate == 0
        assert metrics.scenario_metrics[0].b_compliance_rate == 0

    def test_human_review_compliance_updates_mvp_boundary_rate(self):
        scenario = next(
            item for item in SCENARIOS if item.scenario_id == ScenarioId.MVP_BOUNDARY
        )
        a_runs, b_runs = run_ab_eval(
            MockAgentRunner(),
            ABEvalConfig(instances=1, repeats=1, scenarios=[scenario]),
        )
        rows, _key = generate_blind_review_rows(a_runs, b_runs)
        for row in rows:
            row["review"]["decision_compliant"] = True
            row["review"]["hallucinated_memory"] = False

        metrics = compute_full_metrics(
            a_runs,
            b_runs,
            [scenario],
            human_review_rows=rows,
            human_review_required=True,
        )

        scenario_metrics = metrics.scenario_metrics[0]
        assert scenario_metrics.a_boundary_violation_rate == 0
        assert scenario_metrics.b_boundary_violation_rate == 0

    def test_reviewed_partial_aggregate_only_uses_present_scenarios(self):
        scenario = next(
            item for item in SCENARIOS if item.scenario_id == ScenarioId.REJECTION_HISTORY
        )
        a_runs, b_runs = run_ab_eval(
            MockAgentRunner(),
            ABEvalConfig(instances=1, repeats=1, scenarios=[scenario]),
        )
        rows, _key = generate_blind_review_rows(a_runs, b_runs)
        for row in rows:
            row["review"]["decision_compliant"] = True
            row["review"]["repeats_rejected_plan"] = False
            row["review"]["hallucinated_memory"] = False

        metrics = compute_full_metrics(
            a_runs,
            b_runs,
            human_review_rows=rows,
        )

        assert [item.scenario_id for item in metrics.scenario_metrics] == [
            ScenarioId.REJECTION_HISTORY
        ]

    def test_required_human_review_rejects_incomplete_labels(self):
        runner = MockAgentRunner()
        scenario = SCENARIOS[0]
        a_runs, b_runs = run_ab_eval(
            runner,
            ABEvalConfig(instances=1, repeats=1, scenarios=[scenario]),
        )
        rows, _key = generate_blind_review_rows(a_runs, b_runs)

        with pytest.raises(ValueError, match="incomplete human review"):
            compute_full_metrics(
                a_runs,
                b_runs,
                [scenario],
                human_review_rows=rows,
                human_review_required=True,
            )

    def test_human_review_cannot_clear_automatic_safety_detection(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.PRIVACY)
        a_run = RunOutput(
            group="A",
            scenario_id=scenario.scenario_id,
            instance=0,
            repeat=0,
            output_text="根据历史记忆，小林不愿参加周会。",
            memory_context_text=None,
            used_memory_ids=[],
            token_count_estimate=10,
            latency_ms=10,
            privacy_visibility_verified=True,
            user_prompt=scenario.user_prompt,
        )
        b_run = RunOutput(
            group="B",
            scenario_id=scenario.scenario_id,
            instance=0,
            repeat=0,
            output_text="小林的约束：只能晚上和周末工作，工作日白天有课。",
            memory_context_text=None,
            used_memory_ids=[],
            token_count_estimate=10,
            latency_ms=10,
            privacy_visibility_verified=True,
            user_prompt=scenario.user_prompt,
        )
        rows, _key = generate_blind_review_rows([a_run], [b_run])
        for row in rows:
            row["review"]["hallucinated_memory"] = False
            row["review"]["privacy_leak"] = False

        metrics = compute_full_metrics(
            [a_run],
            [b_run],
            [scenario],
            human_review_rows=rows,
            human_review_required=True,
        )

        assert metrics.total_hallucinated_rate == 1.0
        assert metrics.total_privacy_leak == 1.0


class TestDirectAPIRunner:
    def test_prompt_uses_display_names_and_only_injects_memory_for_b(self):
        scenario = next(s for s in SCENARIOS if s.scenario_id == ScenarioId.MEMBER_CONSTRAINT)
        a_prompt = _build_prompt(scenario.user_prompt, scenario.workspace_state, None)
        b_prompt = _build_prompt(scenario.user_prompt, scenario.workspace_state, "私有记忆内容")

        assert "user-lin" not in a_prompt
        assert "私有记忆内容" not in a_prompt
        assert "私有记忆内容" in b_prompt

    def test_runner_parses_anthropic_response_without_recording_api_key(self, monkeypatch):
        captured = {}

        class Response:
            status_code = 200
            text = ""

            @staticmethod
            def json():
                return {
                    "content": [{"type": "text", "text": "模型回复"}],
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                }

        def fake_post(url, **kwargs):
            captured["url"] = url
            captured.update(kwargs)
            return Response()

        monkeypatch.setattr("httpx.post", fake_post)
        runner = DirectAPIRunner(
            api_key="secret-value",
            base_url="https://model.test/anthropic",
            model="test-model",
        )
        output, tokens, _latency, error = runner.run(
            user_prompt="测试",
            workspace_state={},
            memory_context_text=None,
            scenario_id="test",
        )

        assert captured["headers"]["x-api-key"] == "secret-value"
        assert "secret-value" not in repr(runner.runs)
        assert output == "模型回复"
        assert tokens == 15
        assert error is None


class TestSidecarAgentRunner:
    def test_sidecar_runner_uses_stream_endpoint_and_memory_mode(self, monkeypatch):
        captured_requests = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return (
                    'event: done\ndata: {"final_content":"真实 Agent 回复",'
                    '"memory_evidence":{"mode":"enabled","backend":"fts5",'
                    '"retrieval_count":2,"injected_count":2,'
                    '"used_memory_ids":["mem-1","mem-2"]}}\n\n'
                ).encode()

        def fake_urlopen(request, timeout):
            captured_requests.append((request, timeout))
            return Response()

        monkeypatch.setattr("app.agent.memory.ab_eval.urlopen", fake_urlopen)
        runner = SidecarAgentRunner(
            sidecar_base_url="http://sidecar.test",
            workspace_id="ws-1",
            project_id="project-1",
            conversation_id="conversation-1",
            model_provider="mock",
            model_name="mock-model",
        )

        output, _tokens, _latency, error = runner.run(
            user_prompt="请给出下一步计划",
            workspace_state={"project": {"id": "project-1"}},
            memory_context_text=None,
            scenario_id=ScenarioId.MVP_BOUNDARY.value,
            viewer_user_id="viewer-1",
        )

        request, timeout = captured_requests[0]
        payload = json.loads(request.data.decode("utf-8"))
        assert request.full_url == "http://sidecar.test/runs/stream"
        assert timeout > 0
        assert payload["memory_mode"] == "disabled"
        assert payload["viewer_user_id"] == "viewer-1"
        assert output == "真实 Agent 回复"
        assert error is None
        assert runner.last_memory_evidence == {
            "mode": "enabled",
            "backend": "fts5",
            "retrieval_count": 2,
            "injected_count": 2,
            "used_memory_ids": ["mem-1", "mem-2"],
        }
