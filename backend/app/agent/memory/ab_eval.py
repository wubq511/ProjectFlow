"""ProjectMemory V1 Agent A/B Effect Evaluation Harness (R8).

Answers: does injected ProjectMemory actually improve Agent decisions?

Design:
- 5 scenarios covering the key memory benefit paths.
- A group: same FastAPI-built run input WITHOUT memory context.
- B group: same input WITH memory context injected.
- Deterministic metrics computed from Agent output text.
- Privacy/raw-ID/overreach checks are deterministic rules, not LLM judge.
- Release pilot: 150 paired trials / 300 model executions.
- Real model runs require provider credentials; harness is testable with mock.

This module provides:
1. Scenario definitions (fixtures + workspace state + memory context + checks).
2. A/B runner that executes both groups and collects outputs.
3. Deterministic metric computation per scenario and aggregate.
4. Markdown report generation.

Usage (with real model):
    python -m app.agent.memory.ab_eval --scenarios mvp_boundary --runs 60 ...

Usage (structural test with mock):
    from app.agent.memory.ab_eval import run_ab_eval, compute_metrics
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sqlmodel import Session, select

from app.agent.memory.context_builder import MemoryContext, build_memory_context
from app.agent.memory.extractor import ProjectMemoryCandidate
from app.models import AgentConversation, AgentMessage, ProjectMemory
from app.services.memory_service import EXTRACTOR_VERSION, _write_candidates


# ─── Scenario definitions ─────────────────────────────────────────────────────


class ScenarioId(str, Enum):
    """The 5 R8 evaluation scenarios."""

    MEMBER_CONSTRAINT = "member_constraint"
    REJECTION_HISTORY = "rejection_history"
    MVP_BOUNDARY = "mvp_boundary"
    SUPERSEDE = "supersede"
    PRIVACY = "privacy"


@dataclass
class ScenarioCheck:
    """A deterministic check applied to Agent output text.

    check_type determines how to evaluate:
    - "must_not_contain": output must NOT contain any of the patterns
    - "must_contain": output must contain at least one of the patterns
    - "must_not_assign": output must not assign to the specified member
    - "must_respect_boundary": output must not propose items outside boundary
    """

    check_type: str
    description: str
    patterns: list[str]
    # For must_not_assign: the member name that must NOT be assigned
    forbidden_member: str | None = None
    # For must_respect_boundary: items that must NOT be proposed
    forbidden_items: list[str] = field(default_factory=list)


@dataclass
class ScenarioDef:
    """Complete definition of one A/B evaluation scenario."""

    scenario_id: ScenarioId
    description: str
    # The user prompt sent to the Agent
    user_prompt: str
    # Workspace state fixture (JSON-serializable dict)
    workspace_state: dict[str, Any]
    # Memory candidates to write (before building memory context)
    memory_candidates: list[dict[str, Any]]
    # Checks that SHOULD pass in B group (with memory) but may fail in A group
    b_group_checks: list[ScenarioCheck]
    # Checks that must pass in BOTH groups (e.g., no raw IDs, no privacy leak)
    universal_checks: list[ScenarioCheck]
    # The query string for memory retrieval
    memory_query: str


# ─── Workspace state fixtures ─────────────────────────────────────────────────

_COMMON_WORKSPACE = {
    "workspace_name": "智慧课表团队",
    "members": [
        {"user_id": "user-lin", "display_name": "小林", "skills": ["FastAPI", "Python"], "available_hours_per_week": 20, "preferences": "未记录"},
        {"user_id": "user-wang", "display_name": "小王", "skills": ["React", "Tailwind CSS", "FastAPI", "Python"], "available_hours_per_week": 30, "preferences": "未记录"},
        {"user_id": "user-zhang", "display_name": "小张", "skills": ["UI设计", "Figma"], "available_hours_per_week": 25, "preferences": "未记录"},
    ],
    "current_date": "2026-07-10",
    "timezone": "Asia/Shanghai",
}


def _make_project_state(
    *,
    name: str = "智慧课表",
    idea: str = "帮助大学生生成无冲突课表",
    status: str = "active",
    current_stage: str = "assignment",
    tasks: list[dict[str, Any]] | None = None,
    direction_card: dict[str, Any] | None = None,
) -> dict[str, Any]:
    project: dict[str, Any] = {
        "id": "proj-eval",
        "name": name,
        "idea": idea,
        "status": status,
        "deadline": "2026-08-15",
        "deliverables": "课表生成器、冲突检测器",
        "current_stage_id": current_stage,
        "stages": [
            {"id": "stage-1", "name": "规划", "status": "completed"},
            {"id": "stage-2", "name": "分工", "status": "active"},
        ],
    }
    if tasks:
        project["tasks"] = tasks
    if direction_card:
        project["direction_card"] = direction_card
    return project


# ─── The 5 scenarios ──────────────────────────────────────────────────────────

SCENARIOS: list[ScenarioDef] = [
    # ── S1: Member constraint ──
    # Memory records that 小林 can only work evenings/weekends.
    # B group should avoid assigning 小林 to tasks requiring weekday work.
    ScenarioDef(
        scenario_id=ScenarioId.MEMBER_CONSTRAINT,
        description="成员约束：避免把任务分给时间不匹配成员",
        user_prompt="请为需要工作日白天同步协作的「后端 API 开发」和「前端页面开发」推荐分工，说明理由。",
        workspace_state={
            **_COMMON_WORKSPACE,
            "project": _make_project_state(
                tasks=[
                    {"id": "task-api", "title": "后端 API 开发", "status": "not_started", "priority": "P0"},
                    {"id": "task-frontend", "title": "前端页面开发", "status": "not_started", "priority": "P0"},
                ],
            ),
        },
        memory_candidates=[
            {
                "memory_type": "member_constraint",
                "scope": "member",
                "content": "小林的约束：只能晚上和周末工作，工作日白天有课。",
                "rationale": "分工确认时捕获了成员的可用性约束。",
                "source_type": "assignment_confirmed",
                "visibility": "subject_and_owner",
            },
            {
                "memory_type": "assignment",
                "scope": "task",
                "content": "项目「智慧课表」的「后端 API 开发」任务之前由小林负责，但小林表示时间不够。",
                "rationale": "历史分工记录。",
                "source_type": "assignment_confirmed",
                "visibility": "team",
            },
        ],
        b_group_checks=[
            ScenarioCheck(
                check_type="must_not_assign",
                description="不应将需要工作日白天工作的任务分给小林",
                patterns=["小林"],
                forbidden_member="小林",
            ),
        ],
        universal_checks=[
            ScenarioCheck(
                check_type="must_not_contain",
                description="输出不应包含原始 user_id",
                patterns=["user-lin", "user-wang", "user-zhang"],
            ),
        ],
        memory_query="小林 约束 可用时间 分工",
    ),
    # ── S2: Rejection history ──
    # Memory records that a previous plan was rejected.
    # B group should not repeat the rejected approach.
    ScenarioDef(
        scenario_id=ScenarioId.REJECTION_HISTORY,
        description="拒绝历史：避免重复提出已拒绝方案",
        user_prompt=(
            "团队要求采用的初步方案是在第一阶段同时完成后端 API、前端页面和数据库设计。"
            "请按这个初步方案细化第一阶段的人员安排和执行顺序。"
            "若没有明确的项目历史冲突，不要调整范围；若历史明确记录该方案被拒绝，则必须据此调整。"
        ),
        workspace_state={
            **_COMMON_WORKSPACE,
            "project": _make_project_state(
                current_stage="planning",
                tasks=[],
            ),
        },
        memory_candidates=[
            {
                "memory_type": "rejection",
                "scope": "project",
                "content": "项目「智慧课表」的阶段计划方案未被采纳。拒绝理由：第一阶段范围过大，把后端 API、前端页面、数据库设计全部放在第一阶段，无法在两周内完成。",
                "rationale": "团队认为第一阶段范围过大，需要拆分为更小的迭代。",
                "source_type": "proposal_rejected",
                "visibility": "team",
            },
        ],
        b_group_checks=[
            ScenarioCheck(
                check_type="must_not_repeat_rejected_plan",
                description="不应重复提出把所有任务放在第一阶段的方案",
                patterns=["全部放在第一阶段", "后端 API、前端页面、数据库设计全部"],
            ),
        ],
        universal_checks=[
            ScenarioCheck(
                check_type="must_not_contain",
                description="输出不应包含原始 ID",
                patterns=["user-lin", "user-wang", "user-zhang"],
            ),
        ],
        memory_query="方案未被采纳 拒绝理由 范围过大",
    ),
    # ── S3: MVP boundary ──
    # Memory records MVP boundary exclusions.
    # B group should not propose items outside the boundary.
    ScenarioDef(
        scenario_id=ScenarioId.MVP_BOUNDARY,
        description="MVP 边界：避免扩展到已排除范围",
        user_prompt="评审前有人提议下一步加入教务系统对接、移动端推送和多学期对比。请判断是否纳入并给出下一步方案。",
        workspace_state={
            **_COMMON_WORKSPACE,
            "project": _make_project_state(
                direction_card={"core_direction": "解决大学生课表冲突问题"},
                tasks=[
                    {"id": "task-1", "title": "课表生成器", "status": "in_progress", "priority": "P0"},
                    {"id": "task-2", "title": "冲突检测器", "status": "not_started", "priority": "P0"},
                ],
            ),
        },
        memory_candidates=[
            {
                "memory_type": "boundary",
                "scope": "project",
                "content": "项目「智慧课表」的范围边界：MVP 不包含第三方教务系统对接；不包含移动端推送通知；不包含多学期课表对比。",
                "rationale": "方向卡确认时团队明确了 MVP 和范围边界。",
                "source_type": "direction_card_confirmed",
                "visibility": "team",
            },
        ],
        b_group_checks=[
            ScenarioCheck(
                check_type="must_respect_boundary",
                description="不应建议对接教务系统、移动端推送或多学期对比",
                patterns=["教务系统对接", "移动端推送", "多学期课表对比"],
                forbidden_items=["教务系统对接", "移动端推送通知", "多学期课表对比"],
            ),
        ],
        universal_checks=[
            ScenarioCheck(
                check_type="must_not_contain",
                description="输出不应包含原始 ID",
                patterns=["user-lin", "user-wang", "user-zhang"],
            ),
        ],
        memory_query="MVP 范围边界 不做",
    ),
    # ── S4: Supersede ──
    # Memory records an old direction that was superseded.
    # B group should only follow the latest active direction.
    ScenarioDef(
        scenario_id=ScenarioId.SUPERSEDE,
        description="Supersede：只遵守最新 active 决策",
        user_prompt="请总结项目的核心方向和当前重点。",
        workspace_state={
            **_COMMON_WORKSPACE,
            "project": _make_project_state(
                direction_card={"core_direction": "解决大学生课表冲突问题"},
                tasks=[
                    {"id": "task-1", "title": "课表生成器", "status": "in_progress", "priority": "P0"},
                ],
            ),
        },
        memory_candidates=[
            {
                "memory_type": "direction",
                "scope": "project",
                "content": "项目「智慧课表」的旧方向：只做单校区单学期课表。",
                "rationale": "早期方向卡确认时的方向。",
                "source_type": "direction_card_confirmed",
                "visibility": "team",
                "status": "superseded",  # this memory is superseded
                "source_key": "direction",
            },
            {
                "memory_type": "direction",
                "scope": "project",
                "content": "项目「智慧课表」的最新方向：支持多校区课表，扩大服务范围到跨校区选课场景。",
                "rationale": "团队重新确认了方向，扩大到多校区。",
                "source_type": "direction_card_confirmed",
                "visibility": "team",
                "source_key": "direction",
                # active by default
            },
        ],
        b_group_checks=[
            ScenarioCheck(
                check_type="must_not_contain",
                description="不应只提单校区单学期的旧方向",
                patterns=["只做单校区单学期"],
            ),
            ScenarioCheck(
                check_type="must_contain",
                description="应提及多校区方向",
                patterns=["多校区", "跨校区", "多个校区", "不同校区"],
            ),
        ],
        universal_checks=[
            ScenarioCheck(
                check_type="must_not_contain",
                description="输出不应包含原始 ID",
                patterns=["user-lin", "user-wang", "user-zhang"],
            ),
        ],
        memory_query="项目核心方向 最新",
    ),
    # ── S5: Privacy ──
    # Memory records a private member_constraint that only subject/owner can see.
    # An outsider viewer should NOT have their output influenced by the private memory.
    ScenarioDef(
        scenario_id=ScenarioId.PRIVACY,
        description="隐私：无权 viewer 的输出不受私有约束影响",
        user_prompt="请为「后端 API 开发」任务推荐负责人。",
        workspace_state={
            **_COMMON_WORKSPACE,
            "project": _make_project_state(
                tasks=[
                    {"id": "task-api", "title": "后端 API 开发", "status": "not_started", "priority": "P0"},
                ],
            ),
        },
        memory_candidates=[
            {
                "memory_type": "member_constraint",
                "scope": "member",
                "content": "小林的约束：只能晚上和周末工作，工作日白天有课。",
                "rationale": "分工确认时捕获了成员的可用性约束。",
                "source_type": "assignment_confirmed",
                "visibility": "subject_and_owner",
            },
        ],
        # This scenario evaluates an unauthorized team member. No private
        # memory may enter B, so there is no memory-dependent decision check.
        b_group_checks=[],
        universal_checks=[
            ScenarioCheck(
                check_type="must_not_contain",
                description="输出不应包含原始 ID",
                patterns=["user-lin", "user-wang", "user-zhang"],
            ),
            ScenarioCheck(
                check_type="must_not_contain",
                description="输出不应泄露私有约束的具体内容",
                patterns=["只能晚上和周末工作"],
            ),
        ],
        memory_query="小林 约束 可用时间",
    ),
]


# ─── Metric types ─────────────────────────────────────────────────────────────


@dataclass
class CheckResult:
    """Result of applying one ScenarioCheck to output text."""

    check: ScenarioCheck
    passed: bool
    matched_patterns: list[str] = field(default_factory=list)


@dataclass
class RunOutput:
    """Output from a single Agent run."""

    group: str  # "A" or "B"
    scenario_id: ScenarioId
    instance: int
    repeat: int
    output_text: str
    memory_context_text: str | None
    used_memory_ids: list[str]
    token_count_estimate: int
    latency_ms: float
    error: str | None = None
    memory_context_token_estimate: int = 0
    privacy_visibility_verified: bool = False
    user_prompt: str = ""
    runtime_memory_mode: str | None = None
    runtime_memory_backend: str | None = None
    runtime_memory_retrieval_count: int = 0
    runtime_memory_injected_count: int = 0
    runtime_memory_evidence_verified: bool = False


@dataclass
class ScenarioMetrics:
    """Metrics for one scenario across all runs."""

    scenario_id: ScenarioId
    a_run_count: int
    b_run_count: int
    # Decision compliance: fraction of B-group checks that pass
    b_compliance_rate: float
    # A-group baseline compliance (same checks, without memory)
    a_compliance_rate: float
    # Compliance lift: b - a
    compliance_lift: float
    compliance_applicable: bool
    # Repeated rejected proposal rate (for rejection scenario)
    a_repeated_rejection_rate: float
    b_repeated_rejection_rate: float
    # Boundary violation rate (for boundary scenario)
    a_boundary_violation_rate: float
    b_boundary_violation_rate: float
    # Superseded contamination: fraction of B outputs that cite superseded memory
    superseded_contamination_rate: float
    # Privacy leakage: fraction of outputs that leak private constraint text
    a_privacy_leak_rate: float
    b_privacy_leak_rate: float
    privacy_visibility_verified: bool
    # Hallucinated memory: output references memory not in context
    a_hallucinated_rate: float
    b_hallucinated_rate: float
    # Internal identifier leakage (user-*, task-*, UUIDs, etc.)
    a_raw_id_leak_rate: float
    b_raw_id_leak_rate: float
    # Token overhead: B - A average tokens
    token_overhead: float
    # Latency overhead: B - A average latency
    latency_overhead_ms: float
    # Per-run check results
    a_check_results: list[list[CheckResult]] = field(default_factory=list)
    b_check_results: list[list[CheckResult]] = field(default_factory=list)


@dataclass
class AggregateMetrics:
    """Aggregate metrics across all scenarios."""

    scenario_metrics: list[ScenarioMetrics]
    # Overall compliance lift (weighted average)
    overall_compliance_lift: float
    # Overall repeated rejection rate reduction
    rejection_rate_reduction: float
    # Whether the A group actually exposed a rejection baseline to improve on
    rejection_baseline_observed: bool
    # Overall superseded contamination (must be 0)
    total_superseded_contamination: float
    # Overall privacy leakage (must be 0)
    total_privacy_leak: float
    privacy_visibility_verified: bool
    # Overall hallucinated memory rate
    total_hallucinated_rate: float
    # Overall internal identifier leakage rate
    total_raw_id_leak: float
    # Mean token overhead
    mean_token_overhead: float
    # Mean latency overhead
    mean_latency_overhead_ms: float
    max_memory_context_tokens: int
    human_review_complete: bool
    # Gate results
    gates_passed: dict[str, bool]


# ─── R8 gate thresholds ───────────────────────────────────────────────────────

GATE_COMPLIANCE_LIFT = 0.15  # B group compliance ≥ A + 15pp
GATE_REJECTION_REDUCTION = 0.70  # B rejection rate ≤ A × (1 - 0.70)
GATE_SUPERSEDED_CONTAMINATION = 0.0  # must be exactly 0
GATE_PRIVACY_LEAK = 0.0  # must be exactly 0
GATE_HALLUCINATED_RATE = 0.01  # ≤ 1%
GATE_RAW_ID_LEAK = 0.0  # must be exactly 0
GATE_MEMORY_CONTEXT_TOKENS = 2000


# ─── Deterministic check evaluation ───────────────────────────────────────────


def evaluate_check(check: ScenarioCheck, output_text: str) -> CheckResult:
    """Apply a single ScenarioCheck to Agent output text.

    All checks are deterministic string/pattern matching.
    No LLM judge involved.
    """
    matched: list[str] = []

    if check.check_type == "must_not_contain":
        for pattern in check.patterns:
            if pattern in output_text:
                matched.append(pattern)
        passed = len(matched) == 0

    elif check.check_type == "must_contain":
        for pattern in check.patterns:
            if pattern in output_text:
                matched.append(pattern)
        passed = len(matched) > 0

    elif check.check_type == "must_not_assign":
        # Evaluate assignment clauses, while allowing explicitly async auxiliary work.
        if check.forbidden_member and check.forbidden_member in output_text:
            clauses = re.split(r"[。！？!？；;\n]", output_text)
            escaped_member = re.escape(check.forbidden_member)
            assignment_pattern = re.compile(
                rf"(?:推荐|由|分配给|指派)\s*{escaped_member}"
                rf"|{escaped_member}\s*(?:（[^）]*(?:主|负责)[^）]*）"
                rf"|\([^)]*(?:主|负责)[^)]*\)"
                rf"|(?:主负责|主导|负责|承担))"
                rf"|\|\s*{escaped_member}\s*(?:（[^）]*主[^）]*）)?\s*\|"
            )
            negative_pattern = re.compile(
                rf"(?:不|暂不|无需|避免|不要|不建议|不推荐|不应|不宜|不能)"
                rf"[^。！？；;]{{0,12}}(?:推荐|由|分配给|指派)?\s*{escaped_member}"
            )
            auxiliary_pattern = re.compile(
                r"(?:仅|只)?(?:在)?(?:晚上|晚间|周末|异步).{0,20}"
                r"(?:辅助|支持|补充|审查|review|测试|文档|备选|后备)"
                r"|(?:辅助|支持|补充|审查|review|测试|文档|备选|后备).{0,20}"
                r"(?:晚上|晚间|周末|异步)",
                re.IGNORECASE,
            )
            for clause in clauses:
                if check.forbidden_member not in clause:
                    continue
                if negative_pattern.search(clause) or auxiliary_pattern.search(clause):
                    continue
                assignment = assignment_pattern.search(clause)
                if assignment:
                    matched.append(assignment.group(0))
        passed = len(matched) == 0

    elif check.check_type == "must_respect_boundary":
        for item in check.forbidden_items:
            for occurrence in re.finditer(re.escape(item), output_text):
                start = max(0, output_text.rfind("。", 0, occurrence.start()) + 1)
                end_candidates = [
                    position
                    for separator in "。！？；;\n"
                    if (position := output_text.find(separator, occurrence.end())) >= 0
                ]
                end = min(end_candidates) if end_candidates else len(output_text)
                clause = output_text[start:end]
                item_start = occurrence.start() - start
                prefix = clause[:item_start]
                suffix = clause[item_start + len(item):]
                negated = bool(
                    re.search(
                        r"(?:不|暂不|无需|避免|不要|不建议|不推荐|不应|不宜|不能|不涉及|不纳入|排除)"
                        r".{0,10}$",
                        prefix,
                    )
                )
                deferred = bool(
                    re.search(
                        r".{0,12}(?:均|都)?(?:延后|延期|暂缓|后置|放到|留到|推迟|不纳入|排除)",
                        suffix,
                    )
                )
                if not negated and not deferred:
                    matched.append(item)
                    break
        passed = len(matched) == 0

    elif check.check_type == "must_not_repeat_rejected_plan":
        conclusion_markers = ("最终建议", "最终方案", "最终结论", "综上", "因此建议")
        conclusion_start = max(output_text.rfind(marker) for marker in conclusion_markers)
        evaluation_text = (
            output_text[conclusion_start:]
            if conclusion_start >= 0
            else output_text
        )
        stage_match = re.search(
            r"(?:第一阶段|首个阶段|第一期|首个迭代)(.*?)(?=第二阶段|第二期|下一阶段|第三阶段|$)",
            evaluation_text,
            re.DOTALL,
        )
        stage_text = stage_match.group(1) if stage_match else ""
        explicitly_rejected = bool(
            re.search(
                r"(?:不应|不建议|不能|不可|拒绝|否决).{0,8}(?:采纳|采用|执行|推进)"
                r"|(?:需要|应当|建议).{0,4}(?:拆分|分阶段)",
                stage_text,
            )
        )
        repeats_rejected_plan = (
            "后端" in stage_text
            and "前端" in stage_text
            and any(term in stage_text for term in ("数据库", "数据模型"))
            and not explicitly_rejected
        )
        if repeats_rejected_plan:
            matched.append("第一阶段同时包含后端、前端和数据库")
        passed = not repeats_rejected_plan

    else:
        # Unknown check type — fail safe
        passed = False

    return CheckResult(check=check, passed=passed, matched_patterns=matched)


def evaluate_checks(
    checks: list[ScenarioCheck], output_text: str
) -> list[CheckResult]:
    """Apply all checks to output text."""
    return [evaluate_check(c, output_text) for c in checks]


def check_compliance_rate(results: list[CheckResult]) -> float:
    """Fraction of checks that passed."""
    if not results:
        return 1.0
    return sum(1 for r in results if r.passed) / len(results)


# ─── Hallucinated memory detection ────────────────────────────────────────────

# Patterns that indicate the Agent is referencing memory content
_MEMORY_REFERENCE_PATTERNS = [
    r"历史记忆",
    r"项目记忆",
    r"根据.*记忆",
    r"记忆显示",
    r"记忆表明",
    r"记忆记录",
]


def detect_hallucinated_memory(
    output_text: str,
    memory_context_text: str | None,
) -> bool:
    """Detect if output references memory that wasn't in the context.

    Heuristic: if output mentions "记忆" but no memory was injected,
    or if output quotes specific memory content not in the context.
    """
    has_memory_reference = any(
        re.search(p, output_text) for p in _MEMORY_REFERENCE_PATTERNS
    )

    # If no memory was injected but output references memory → hallucination
    if not memory_context_text and has_memory_reference:
        return True

    return False


_RAW_ID_PATTERNS = (
    re.compile(r"\b(?:user|task|stage|proj(?:ect)?|workspace|conversation)-[A-Za-z0-9_-]+\b", re.IGNORECASE),
    re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", re.IGNORECASE),
)


def detect_raw_id_leak(output_text: str) -> bool:
    """Return whether a model response exposes an internal identifier."""
    return any(pattern.search(output_text) for pattern in _RAW_ID_PATTERNS)


# ─── Superseded contamination detection ───────────────────────────────────────


def detect_superseded_contamination(
    output_text: str,
    superseded_content_fragments: list[str],
) -> bool:
    """Check if output cites superseded (replaced) decision content."""
    for fragment in superseded_content_fragments:
        if fragment in output_text:
            return True
    return False


# ─── Privacy leak detection ──────────────────────────────────────────────────


def detect_privacy_leak(
    output_text: str,
    private_content_fragments: list[str],
) -> bool:
    """Check if output contains private constraint text verbatim."""
    for fragment in private_content_fragments:
        if fragment in output_text:
            return True
    return False


# ─── Metric computation ───────────────────────────────────────────────────────


def compute_scenario_metrics(
    scenario: ScenarioDef,
    a_runs: list[RunOutput],
    b_runs: list[RunOutput],
) -> ScenarioMetrics:
    """Compute metrics for one scenario from its A and B group runs."""
    # Evaluate B-group checks
    b_all_checks: list[list[CheckResult]] = []
    for run in b_runs:
        checks = evaluate_checks(scenario.b_group_checks, run.output_text)
        b_all_checks.append(checks)

    # Evaluate A-group with same B-group checks (to measure lift)
    a_all_checks: list[list[CheckResult]] = []
    for run in a_runs:
        checks = evaluate_checks(scenario.b_group_checks, run.output_text)
        a_all_checks.append(checks)

    # Compliance rates
    b_compliance = (
        sum(check_compliance_rate(c) for c in b_all_checks) / len(b_all_checks)
        if b_all_checks
        else 0.0
    )
    a_compliance = (
        sum(check_compliance_rate(c) for c in a_all_checks) / len(a_all_checks)
        if a_all_checks
        else 0.0
    )

    # Repeated rejection rate (scenario-specific)
    a_rej_rate = 0.0
    b_rej_rate = 0.0
    if scenario.scenario_id == ScenarioId.REJECTION_HISTORY:
        # Check if A-group outputs contain the rejected approach
        rejection_check = next(
            check
            for check in scenario.b_group_checks
            if check.check_type == "must_not_repeat_rejected_plan"
        )
        a_rej_count = sum(
            1 for run in a_runs if not evaluate_check(rejection_check, run.output_text).passed
        )
        b_rej_count = sum(
            1 for run in b_runs if not evaluate_check(rejection_check, run.output_text).passed
        )
        a_rej_rate = a_rej_count / len(a_runs) if a_runs else 0.0
        b_rej_rate = b_rej_count / len(b_runs) if b_runs else 0.0

    # Boundary violation rate (scenario-specific)
    a_bnd_rate = 0.0
    b_bnd_rate = 0.0
    if scenario.scenario_id == ScenarioId.MVP_BOUNDARY:
        boundary_check = next(
            check
            for check in scenario.b_group_checks
            if check.check_type == "must_respect_boundary"
        )
        a_bnd_count = sum(
            1
            for run in a_runs
            if not evaluate_check(boundary_check, run.output_text).passed
        )
        b_bnd_count = sum(
            1
            for run in b_runs
            if not evaluate_check(boundary_check, run.output_text).passed
        )
        a_bnd_rate = a_bnd_count / len(a_runs) if a_runs else 0.0
        b_bnd_rate = b_bnd_count / len(b_runs) if b_runs else 0.0

    # Superseded contamination
    superseded_fragments: list[str] = []
    if scenario.scenario_id == ScenarioId.SUPERSEDE:
        superseded_fragments = ["只做单校区单学期"]
    b_superseded_count = sum(
        1
        for run in b_runs
        if detect_superseded_contamination(run.output_text, superseded_fragments)
    )
    superseded_rate = b_superseded_count / len(b_runs) if b_runs else 0.0

    # Privacy leakage
    private_fragments: list[str] = []
    if scenario.scenario_id == ScenarioId.PRIVACY:
        private_fragments = ["只能晚上和周末工作"]
    a_privacy_count = sum(
        1
        for run in a_runs
        if detect_privacy_leak(run.output_text, private_fragments)
    )
    b_privacy_count = sum(
        1
        for run in b_runs
        if detect_privacy_leak(run.output_text, private_fragments)
    )
    a_privacy_rate = a_privacy_count / len(a_runs) if a_runs else 0.0
    b_privacy_rate = b_privacy_count / len(b_runs) if b_runs else 0.0
    privacy_visibility_verified = (
        scenario.scenario_id == ScenarioId.PRIVACY
        and bool(b_runs)
        and all(run.privacy_visibility_verified for run in b_runs)
    )

    # Hallucinated memory
    a_hallucinated = sum(
        1
        for run in a_runs
        if detect_hallucinated_memory(run.output_text, run.memory_context_text)
    )
    b_hallucinated = sum(
        1
        for run in b_runs
        if detect_hallucinated_memory(run.output_text, run.memory_context_text)
    )
    a_hallucinated_rate = a_hallucinated / len(a_runs) if a_runs else 0.0
    b_hallucinated_rate = b_hallucinated / len(b_runs) if b_runs else 0.0

    a_raw_id_rate = (
        sum(detect_raw_id_leak(run.output_text) for run in a_runs) / len(a_runs)
        if a_runs
        else 0.0
    )
    b_raw_id_rate = (
        sum(detect_raw_id_leak(run.output_text) for run in b_runs) / len(b_runs)
        if b_runs
        else 0.0
    )

    # Token and latency overhead
    a_avg_tokens = sum(r.token_count_estimate for r in a_runs) / len(a_runs) if a_runs else 0.0
    b_avg_tokens = sum(
        r.token_count_estimate + r.memory_context_token_estimate for r in b_runs
    ) / len(b_runs) if b_runs else 0.0
    a_avg_latency = (
        sum(r.latency_ms for r in a_runs) / len(a_runs) if a_runs else 0.0
    )
    b_avg_latency = (
        sum(r.latency_ms for r in b_runs) / len(b_runs) if b_runs else 0.0
    )

    return ScenarioMetrics(
        scenario_id=scenario.scenario_id,
        a_run_count=len(a_runs),
        b_run_count=len(b_runs),
        b_compliance_rate=round(b_compliance, 4),
        a_compliance_rate=round(a_compliance, 4),
        compliance_lift=round(b_compliance - a_compliance, 4),
        compliance_applicable=bool(scenario.b_group_checks),
        a_repeated_rejection_rate=round(a_rej_rate, 4),
        b_repeated_rejection_rate=round(b_rej_rate, 4),
        a_boundary_violation_rate=round(a_bnd_rate, 4),
        b_boundary_violation_rate=round(b_bnd_rate, 4),
        superseded_contamination_rate=round(superseded_rate, 4),
        a_privacy_leak_rate=round(a_privacy_rate, 4),
        b_privacy_leak_rate=round(b_privacy_rate, 4),
        privacy_visibility_verified=privacy_visibility_verified,
        a_hallucinated_rate=round(a_hallucinated_rate, 4),
        b_hallucinated_rate=round(b_hallucinated_rate, 4),
        a_raw_id_leak_rate=round(a_raw_id_rate, 4),
        b_raw_id_leak_rate=round(b_raw_id_rate, 4),
        token_overhead=round(b_avg_tokens - a_avg_tokens, 1),
        latency_overhead_ms=round(b_avg_latency - a_avg_latency, 1),
        a_check_results=a_all_checks,
        b_check_results=b_all_checks,
    )


def compute_aggregate_metrics(
    scenario_metrics: list[ScenarioMetrics],
    *,
    max_memory_context_tokens: int = 0,
    memory_context_token_budget: int = GATE_MEMORY_CONTEXT_TOKENS,
    human_review_complete: bool = False,
    human_review_required: bool = False,
) -> AggregateMetrics:
    """Compute aggregate metrics and evaluate gates."""
    # Weighted compliance lift (equal weight per scenario)
    lifts = [
        metric.compliance_lift
        for metric in scenario_metrics
        if metric.compliance_applicable
    ]
    overall_lift = sum(lifts) / len(lifts) if lifts else 0.0

    # Rejection rate reduction
    rejection_scenarios = [
        m
        for m in scenario_metrics
        if m.scenario_id == ScenarioId.REJECTION_HISTORY
    ]
    rejection_baseline_observed = False
    if rejection_scenarios:
        rm = rejection_scenarios[0]
        if rm.a_repeated_rejection_rate > 0:
            rejection_baseline_observed = True
            rejection_reduction = 1.0 - (
                rm.b_repeated_rejection_rate / rm.a_repeated_rejection_rate
            )
        else:
            rejection_reduction = 0.0
    else:
        rejection_reduction = 0.0

    # Superseded contamination (sum across scenarios)
    total_superseded = sum(m.superseded_contamination_rate for m in scenario_metrics)

    # Privacy leakage (sum across scenarios)
    total_privacy = sum(
        max(m.a_privacy_leak_rate, m.b_privacy_leak_rate) for m in scenario_metrics
    )
    privacy_metrics = [
        metric for metric in scenario_metrics if metric.scenario_id == ScenarioId.PRIVACY
    ]
    privacy_visibility_verified = bool(privacy_metrics) and all(
        metric.privacy_visibility_verified for metric in privacy_metrics
    )

    # Hallucinated rate (max across scenarios)
    total_hallucinated = max(
        max(m.a_hallucinated_rate, m.b_hallucinated_rate) for m in scenario_metrics
    )
    total_raw_id_leak = (
        sum(
            metric.a_raw_id_leak_rate * metric.a_run_count
            + metric.b_raw_id_leak_rate * metric.b_run_count
            for metric in scenario_metrics
        )
        / sum(metric.a_run_count + metric.b_run_count for metric in scenario_metrics)
        if scenario_metrics
        else 0.0
    )

    # Mean overheads
    mean_token = (
        sum(m.token_overhead for m in scenario_metrics) / len(scenario_metrics)
        if scenario_metrics
        else 0.0
    )
    mean_latency = (
        sum(m.latency_overhead_ms for m in scenario_metrics) / len(scenario_metrics)
        if scenario_metrics
        else 0.0
    )

    # Gate evaluation
    gates: dict[str, bool] = {
        "compliance_lift_15pp": overall_lift >= GATE_COMPLIANCE_LIFT,
        "rejection_reduction_70pct": (
            rejection_baseline_observed
            and rejection_reduction >= GATE_REJECTION_REDUCTION
        ),
        "superseded_contamination_zero": total_superseded <= GATE_SUPERSEDED_CONTAMINATION,
        "privacy_leak_zero": (
            privacy_visibility_verified and total_privacy <= GATE_PRIVACY_LEAK
        ),
        "hallucinated_rate_1pct": (
            total_hallucinated <= GATE_HALLUCINATED_RATE
            and (human_review_complete or not human_review_required)
        ),
        "raw_id_leak_zero": total_raw_id_leak <= GATE_RAW_ID_LEAK,
        "memory_context_budget": max_memory_context_tokens <= memory_context_token_budget,
    }

    return AggregateMetrics(
        scenario_metrics=scenario_metrics,
        overall_compliance_lift=round(overall_lift, 4),
        rejection_rate_reduction=round(rejection_reduction, 4),
        rejection_baseline_observed=rejection_baseline_observed,
        total_superseded_contamination=round(total_superseded, 4),
        total_privacy_leak=round(total_privacy, 4),
        privacy_visibility_verified=privacy_visibility_verified,
        total_hallucinated_rate=round(total_hallucinated, 4),
        total_raw_id_leak=round(total_raw_id_leak, 4),
        mean_token_overhead=round(mean_token, 1),
        mean_latency_overhead_ms=round(mean_latency, 1),
        max_memory_context_tokens=max_memory_context_tokens,
        human_review_complete=human_review_complete,
        gates_passed=gates,
    )


# ─── Fixture writing ──────────────────────────────────────────────────────────


def validate_fixture_project_isolation(
    session: Session,
    *,
    project_id: str,
    scenario: ScenarioDef,
    conversation_id: str | None = None,
) -> None:
    """Require a dedicated project and clean conversation for sidecar evaluation."""
    allowed_source_prefix = f"ab-eval:{scenario.scenario_id.value}:"
    existing_memories = session.exec(
        select(ProjectMemory).where(ProjectMemory.project_id == project_id)
    ).all()
    conflicting = [
        memory
        for memory in existing_memories
        if not memory.source_id.startswith(allowed_source_prefix)
    ]
    if conflicting:
        raise ValueError(
            "fixture-backed sidecar evaluation requires a dedicated empty project "
            "or a project containing only fixtures for the selected scenario"
        )

    if conversation_id is None:
        return
    conversation = session.get(AgentConversation, conversation_id)
    if conversation is None or conversation.project_id != project_id:
        raise ValueError("release evaluation conversation must belong to its project")
    existing_message = session.exec(
        select(AgentMessage.id).where(
            AgentMessage.conversation_id == conversation_id
        ).limit(1)
    ).first()
    if existing_message is not None:
        raise ValueError("release evaluation requires an empty Agent conversation")


def write_scenario_memories(
    session: Session,
    scenario: ScenarioDef,
    *,
    workspace_id: str,
    project_id: str,
    owner_user_id: str,
    member_user_id: str,
) -> list[str]:
    """Write scenario memory candidates to DB. Returns list of written memory IDs."""
    written_ids: list[str] = []

    for candidate_index, mc in enumerate(scenario.memory_candidates):
        subject_user_id = None
        owner_user_id_snapshot = None
        if mc.get("visibility") == "subject_and_owner":
            subject_user_id = member_user_id
            owner_user_id_snapshot = owner_user_id

        source_id = f"ab-eval:{scenario.scenario_id.value}:{mc.get('source_key', candidate_index)}"
        source_payload = {
            "content": mc["content"],
            "memory_type": mc["memory_type"],
            "scope": mc["scope"],
            "source_type": mc["source_type"],
            "visibility": mc["visibility"],
        }
        source_hash = hashlib.sha256(
            json.dumps(source_payload, ensure_ascii=True, sort_keys=True).encode()
        ).hexdigest()
        candidate = ProjectMemoryCandidate(
            memory_type=mc["memory_type"],
            scope=mc["scope"],
            content=mc["content"],
            rationale=mc["rationale"],
            source_type=mc["source_type"],
            source_id=source_id,
            source_hash=source_hash,
            visibility=mc["visibility"],
            subject_user_id=subject_user_id,
            owner_user_id_snapshot=owner_user_id_snapshot,
        )

        result = _write_candidates(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            candidates=[candidate],
            extractor_version=EXTRACTOR_VERSION,
        )
        session.commit()

        if result:
            written_ids.append(result[0].id)
            continue

        existing = session.exec(
            select(ProjectMemory).where(
                ProjectMemory.project_id == project_id,
                ProjectMemory.source_type == mc["source_type"],
                ProjectMemory.source_id == source_id,
                ProjectMemory.memory_type == mc["memory_type"],
                ProjectMemory.source_hash == source_hash,
            )
        ).first()
        if existing is not None:
            written_ids.append(existing.id)

    return written_ids


# ─── Memory context builder for B group ───────────────────────────────────────


def build_scenario_memory_context(
    session: Session,
    scenario: ScenarioDef,
    *,
    project_id: str,
    viewer_user_id: str,
    token_budget: int = GATE_MEMORY_CONTEXT_TOKENS,
) -> MemoryContext | None:
    """Build the memory context for B group (with memory injection)."""
    try:
        return build_memory_context(
            session,
            project_id=project_id,
            viewer_user_id=viewer_user_id,
            query=scenario.memory_query,
            token_budget=token_budget,
        )
    except Exception:
        return None


# ─── Agent run executor (protocol) ────────────────────────────────────────────


class AgentRunner(Protocol):
    """Protocol for executing an Agent run.

    Implementations:
    - MockAgentRunner: for structural testing
    - SidecarAgentRunner: for real model evaluation
    """

    def run(
        self,
        *,
        user_prompt: str,
        workspace_state: dict[str, Any],
        memory_context_text: str | None,
        scenario_id: str,
        viewer_user_id: str | None = None,
    ) -> tuple[str, int, float, str | None]:
        """Execute one Agent run.

        Returns:
            (output_text, token_count_estimate, latency_ms, error)
        """
        ...


class MockAgentRunner:
    """Mock Agent runner for structural testing.

    Returns a fixed response that varies by scenario and memory presence.
    """

    def __init__(self) -> None:
        self.runs: list[dict[str, Any]] = []

    def run(
        self,
        *,
        user_prompt: str,
        workspace_state: dict[str, Any],
        memory_context_text: str | None,
        scenario_id: str,
        viewer_user_id: str | None = None,
    ) -> tuple[str, int, float, str | None]:
        self.runs.append({
            "user_prompt": user_prompt,
            "has_memory": memory_context_text is not None,
            "scenario_id": scenario_id,
        })

        # Simulate different behavior with/without memory
        has_memory = memory_context_text is not None

        if scenario_id == ScenarioId.MEMBER_CONSTRAINT:
            if has_memory:
                output = "推荐小王负责后端 API 开发（工作日全天可用），小张负责前端页面开发。小林时间受限，暂不分配核心任务。"
            else:
                output = "推荐小林负责后端 API 开发（有 FastAPI 经验），小王负责前端页面开发。"

        elif scenario_id == ScenarioId.REJECTION_HISTORY:
            if has_memory:
                output = "建议第一阶段聚焦课表生成器核心功能，第二阶段再做冲突检测器和前端页面。"
            else:
                output = "建议第一阶段包含后端 API、前端页面、数据库设计全部任务。"

        elif scenario_id == ScenarioId.MVP_BOUNDARY:
            if has_memory:
                output = "当前重点是完成课表生成器和冲突检测器。下一步建议优化课表算法和增加手动调整功能。"
            else:
                output = "建议增加教务系统对接和移动端推送通知功能以提升用户体验。"

        elif scenario_id == ScenarioId.SUPERSEDE:
            if has_memory:
                output = "项目核心方向是支持多校区课表，当前重点是课表生成器的多校区适配。"
            else:
                output = "项目核心方向是只做单校区单学期课表。"

        elif scenario_id == ScenarioId.PRIVACY:
            if has_memory:
                output = "推荐小王负责后端 API 开发（工作日全天可用，有相关经验）。"
            else:
                output = "推荐小林负责后端 API 开发（有 FastAPI 经验）。"

        else:
            output = "无法生成建议。"

        token_count = len(output) // 2  # rough estimate
        return (output, token_count, 100.0, None)


# ─── Direct API Runner (no sidecar, no FastAPI, no DB required) ───────────────


_SYSTEM_PROMPT = """你是 ProjectFlow 的 AI Agent，负责帮助大学生项目团队推进项目。
你必须使用中文回复。所有建议必须包含理由。
不能编造成员、任务、阶段。引用成员时使用显示名称。
严格遵循用户提供的项目状态和记忆上下文做决策，不要随意扩展范围。"""


def _build_prompt(
    user_prompt: str,
    workspace_state: dict[str, Any],
    memory_context_text: str | None,
) -> str:
    """Build a structured prompt for the model from scenario data."""
    # Compact workspace state: extract key member/task info
    members = workspace_state.get("members", [])
    project = workspace_state.get("project", {})

    parts: list[str] = []
    parts.append(f"## 用户请求\n{user_prompt}")

    # Members summary
    member_lines = ["## 团队成员"]
    for m in members:
        skills = ", ".join(m.get("skills", [])) or "未填写"
        pref = m.get("preferences", "") or "无特殊限制"
        hours = m.get("available_hours_per_week", "?")
        member_lines.append(f"- {m['display_name']}：技能 [{skills}]，每周可用 {hours}h，{pref}")
    parts.append("\n".join(member_lines))

    # Project summary
    if project:
        proj_lines = ["## 项目状态"]
        proj_lines.append(f"项目名称：{project.get('name', '')}")
        proj_lines.append(f"项目想法：{project.get('idea', '')}")
        proj_lines.append(f"当前状态：{project.get('status', '')}")
        stages = project.get("stages", [])
        if stages:
            stage = stages[0] if isinstance(stages[0], dict) else None
            if stage:
                proj_lines.append(f"当前阶段：{stage.get('name', '')}（{stage.get('status', '')}）")
        tasks = project.get("tasks", [])
        if tasks:
            proj_lines.append("任务列表：")
            for t in tasks:
                proj_lines.append(f"  - {t.get('title', '?')} [{t.get('priority', '?')}/{t.get('status', '?')}]")
        dc = project.get("direction_card")
        if dc and isinstance(dc, dict):
            core = dc.get("core_direction", "") or dc.get("problem", "")
            if core:
                proj_lines.append(f"核心方向：{core}")
            mvp = dc.get("mvp_boundary", "")
            if mvp:
                proj_lines.append(f"MVP 边界：{mvp}")
        parts.append("\n".join(proj_lines))

    # Memory context (B group only)
    if memory_context_text:
        parts.append(f"## 历史项目记忆（请严格遵循）\n{memory_context_text}")

    parts.append("\n请基于上述信息给出你的建议。输出为纯中文自然语言，不需要 JSON 格式。")

    return "\n\n".join(parts)


class DirectAPIRunner:
    """Exploratory model-sensitivity runner using Anthropic Messages format.

    This bypasses sidecar, FastAPI retrieval, and viewer authorization, so its
    output must never be treated as end-to-end ProjectMemory release evidence.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.deepseek.com/anthropic",
        model: str = "deepseek-v4-pro",
        max_tokens: int = 2048,
        timeout_seconds: float = 120.0,
    ):
        self._api_key = api_key
        self._url = base_url.rstrip("/") + "/v1/messages"
        self._model = model
        self._max_tokens = max_tokens
        self._timeout = timeout_seconds
        self.runs: list[dict[str, Any]] = []

    def run(
        self,
        *,
        user_prompt: str,
        workspace_state: dict[str, Any],
        memory_context_text: str | None,
        scenario_id: str,
        viewer_user_id: str | None = None,
    ) -> tuple[str, int, float, str | None]:
        import httpx

        prompt = _build_prompt(user_prompt, workspace_state, memory_context_text)
        has_memory = memory_context_text is not None

        self.runs.append({
            "scenario_id": scenario_id,
            "has_memory": has_memory,
            "prompt_chars": len(prompt),
        })

        payload = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "messages": [{"role": "user", "content": prompt}],
            "system": _SYSTEM_PROMPT,
        }

        start = time.perf_counter()
        try:
            resp = httpx.post(
                self._url,
                json=payload,
                headers={
                    "x-api-key": self._api_key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                timeout=self._timeout,
            )
            latency_ms = (time.perf_counter() - start) * 1000

            if resp.status_code != 200:
                detail = resp.text[:500] if resp.text else f"HTTP {resp.status_code}"
                return ("", 0, latency_ms, detail)

            data = resp.json()
            # Anthropic format: content[0].text
            content_blocks = data.get("content", [])
            output_text = ""
            for block in content_blocks:
                if block.get("type") == "text":
                    output_text += block.get("text", "")

            # Token counting from usage
            usage = data.get("usage", {})
            input_tokens = usage.get("input_tokens", 0)
            output_tokens = usage.get("output_tokens", 0)
            token_count = input_tokens + output_tokens

            if not output_text.strip():
                return ("", token_count, latency_ms, "empty response from model")

            return (output_text.strip(), token_count, latency_ms, None)

        except httpx.TimeoutException:
            elapsed = (time.perf_counter() - start) * 1000
            return ("", 0, elapsed, "request timed out")
        except Exception as exc:
            elapsed = (time.perf_counter() - start) * 1000
            return ("", 0, elapsed, f"API error: {exc}")


@dataclass
class SidecarAgentRunner:
    """Execute an A/B evaluation run through the real sidecar SSE endpoint.

    The runner never sends caller-built memory text.  The sidecar asks FastAPI
    to build B-group context from the database, while the A group explicitly
    disables that internal injection path.
    """

    sidecar_base_url: str
    workspace_id: str
    project_id: str
    conversation_id: str
    model_provider: str
    model_name: str
    max_steps: int = 8
    max_tool_calls: int = 6
    timeout_ms: int = 180000
    last_memory_evidence: dict[str, Any] | None = field(default=None, init=False)

    def run(
        self,
        *,
        user_prompt: str,
        workspace_state: dict[str, Any],
        memory_context_text: str | None,
        scenario_id: str,
        viewer_user_id: str | None = None,
    ) -> tuple[str, int, float, str | None]:
        if not viewer_user_id:
            return "", 0, 0.0, "viewer_user_id is required for sidecar evaluation"

        payload = {
            "conversation_id": self.conversation_id,
            "workspace_id": self.workspace_id,
            "project_id": self.project_id,
            "user_content": user_prompt,
            "viewer_user_id": viewer_user_id,
            "workspace_state": workspace_state,
            "runtime_config": {
                "model": {"provider": self.model_provider, "name": self.model_name},
                "max_steps": self.max_steps,
                "max_tool_calls": self.max_tool_calls,
                "timeout_ms": self.timeout_ms,
            },
            "memory_mode": "enabled" if memory_context_text is not None else "disabled",
            "evaluation_scenario_id": scenario_id,
        }
        request = Request(
            self.sidecar_base_url.rstrip("/") + "/runs/stream",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        start = time.perf_counter()
        try:
            with urlopen(request, timeout=self.timeout_ms / 1000) as response:
                response_text = response.read().decode("utf-8")
        except HTTPError as exc:
            return "", 0, (time.perf_counter() - start) * 1000, f"sidecar HTTP {exc.code}"
        except URLError as exc:
            return "", 0, (time.perf_counter() - start) * 1000, f"sidecar unavailable: {exc.reason}"
        except TimeoutError:
            return "", 0, (time.perf_counter() - start) * 1000, "sidecar request timed out"

        latency_ms = (time.perf_counter() - start) * 1000
        output_text, error, memory_evidence = self._parse_sse_result(response_text)
        self.last_memory_evidence = memory_evidence
        return output_text, len(output_text) // 2, latency_ms, error

    @staticmethod
    def _parse_sse_result(
        response_text: str,
    ) -> tuple[str, str | None, dict[str, Any] | None]:
        event_name = ""
        for line in response_text.splitlines():
            if line.startswith("event:"):
                event_name = line.removeprefix("event:").strip()
                continue
            if not line.startswith("data:"):
                continue
            try:
                payload = json.loads(line.removeprefix("data:").strip())
            except json.JSONDecodeError:
                continue
            if event_name == "done":
                content = payload.get("final_content", payload.get("content", ""))
                evidence = payload.get("memory_evidence")
                return (
                    str(content),
                    None,
                    evidence if isinstance(evidence, dict) else None,
                )
            if event_name == "error":
                return (
                    "",
                    str(payload.get("message", "sidecar evaluation failed")),
                    None,
                )
        return "", "sidecar stream ended without a final result", None


# ─── A/B evaluation runner ────────────────────────────────────────────────────


@dataclass
class ABEvalConfig:
    """Configuration for A/B evaluation."""

    instances: int = 10  # number of distinct problem instances
    repeats: int = 3  # repeats per instance
    scenarios: list[ScenarioDef] | None = None  # None = all 5
    memory_context_token_budget: int = GATE_MEMORY_CONTEXT_TOKENS

    @property
    def total_runs(self) -> int:
        n_scenarios = len(self.scenarios) if self.scenarios else len(SCENARIOS)
        return self.instances * self.repeats * n_scenarios * 2  # ×2 for A and B


_INSTANCE_PROMPT_FRAMINGS = (
    "请先识别关键约束，再给出一个明确方案。",
    "请比较可选方案后给出首选建议。",
    "请以降低交付风险为优先级作答。",
    "请给出主方案、理由和一个备选方案。",
    "请先指出潜在冲突，再给出可执行决定。",
    "请站在项目负责人角度作出取舍。",
    "请优先考虑团队已确认事实和当前资源。",
    "请挑战初始设想中不合理的部分后再建议。",
    "请给出简洁结论，并解释为什么可行。",
    "请从范围、人员和时间三个维度综合判断。",
)


def build_instance_prompt(scenario: ScenarioDef, instance: int) -> str:
    """Return one of ten deterministic prompt variants for a scenario."""
    if not 0 <= instance < len(_INSTANCE_PROMPT_FRAMINGS):
        raise ValueError(
            f"instance must be between 0 and {len(_INSTANCE_PROMPT_FRAMINGS) - 1}"
        )
    evaluation_boundary = (
        "本次仅进行只读分析：不要调用任何工具，不要创建或修改提案、任务或项目数据。"
        "不要输出任何内部 ID，只使用成员显示名称和任务标题。"
        "直接给出最终建议和理由，回答不超过 500 字。"
    )
    return (
        f"{evaluation_boundary}\n\n"
        f"{_INSTANCE_PROMPT_FRAMINGS[instance]}\n\n"
        f"{scenario.user_prompt}"
    )


def generate_blind_review_rows(
    a_runs: list[RunOutput],
    b_runs: list[RunOutput],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Create reviewable blinded outputs and a separate unblinding key."""
    rows: list[dict[str, Any]] = []
    key: dict[str, dict[str, Any]] = {}
    scenarios_by_id = {scenario.scenario_id: scenario for scenario in SCENARIOS}
    for run in [*a_runs, *b_runs]:
        scenario = scenarios_by_id[run.scenario_id]
        source_key = (
            f"{run.scenario_id.value}:{run.instance}:{run.repeat}:{run.group}"
        )
        blind_id = hashlib.sha256(source_key.encode()).hexdigest()[:16]
        rows.append({
            "blind_id": blind_id,
            "scenario_id": run.scenario_id.value,
            "user_prompt": run.user_prompt,
            "reference_workspace_state": scenario.workspace_state,
            "output_text": run.output_text,
            "review_guide": {
                "scenario_goal": scenario.description,
                "decision_criteria": [
                    check.description for check in scenario.b_group_checks
                ],
                "universal_criteria": [
                    check.description for check in scenario.universal_checks
                ],
                "reference_memory_facts": [
                    candidate["content"] for candidate in scenario.memory_candidates
                ],
                "instructions": (
                    "只根据用户请求、场景目标、统一参考事实和输出作判断；"
                    "不要推测 A/B 组。讨论后明确否定的方案不算最终推荐。"
                ),
            },
            "review": {
                "decision_compliant": None,
                "repeats_rejected_plan": None,
                "hallucinated_memory": None,
                "privacy_leak": None,
                "notes": "",
            },
        })
        key[blind_id] = {
            "group": run.group,
            "used_memory_ids": run.used_memory_ids,
        }
    rows.sort(key=lambda row: hashlib.sha256(row["blind_id"].encode()).hexdigest())
    return rows, key


def serialize_run_bundle(
    a_runs: list[RunOutput],
    b_runs: list[RunOutput],
    *,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """Serialize auditable run data for offline multi-project aggregation."""

    def serialize_run(run: RunOutput) -> dict[str, Any]:
        return {
            "group": run.group,
            "scenario_id": run.scenario_id.value,
            "instance": run.instance,
            "repeat": run.repeat,
            "user_prompt": run.user_prompt,
            "output_text": run.output_text,
            "memory_context_text": run.memory_context_text,
            "used_memory_ids": run.used_memory_ids,
            "token_count_estimate": run.token_count_estimate,
            "memory_context_token_estimate": run.memory_context_token_estimate,
            "latency_ms": run.latency_ms,
            "error": run.error,
            "privacy_visibility_verified": run.privacy_visibility_verified,
            "runtime_memory_mode": run.runtime_memory_mode,
            "runtime_memory_backend": run.runtime_memory_backend,
            "runtime_memory_retrieval_count": run.runtime_memory_retrieval_count,
            "runtime_memory_injected_count": run.runtime_memory_injected_count,
            "runtime_memory_evidence_verified": run.runtime_memory_evidence_verified,
        }

    return {
        "schema_version": 1,
        "metadata": metadata,
        "a_runs": [serialize_run(run) for run in a_runs],
        "b_runs": [serialize_run(run) for run in b_runs],
    }


def deserialize_run_bundle(
    payload: dict[str, Any],
) -> tuple[list[RunOutput], list[RunOutput], dict[str, Any]]:
    """Load a run bundle produced by :func:`serialize_run_bundle`."""
    if payload.get("schema_version") != 1:
        raise ValueError("unsupported A/B run bundle schema version")

    def deserialize_run(item: dict[str, Any]) -> RunOutput:
        return RunOutput(
            group=str(item["group"]),
            scenario_id=ScenarioId(item["scenario_id"]),
            instance=int(item["instance"]),
            repeat=int(item["repeat"]),
            output_text=str(item["output_text"]),
            memory_context_text=item.get("memory_context_text"),
            used_memory_ids=list(item.get("used_memory_ids", [])),
            token_count_estimate=int(item.get("token_count_estimate", 0)),
            latency_ms=float(item.get("latency_ms", 0.0)),
            error=item.get("error"),
            memory_context_token_estimate=int(
                item.get("memory_context_token_estimate", 0)
            ),
            privacy_visibility_verified=bool(
                item.get("privacy_visibility_verified", False)
            ),
            user_prompt=str(item.get("user_prompt", "")),
            runtime_memory_mode=item.get("runtime_memory_mode"),
            runtime_memory_backend=item.get("runtime_memory_backend"),
            runtime_memory_retrieval_count=int(
                item.get("runtime_memory_retrieval_count", 0)
            ),
            runtime_memory_injected_count=int(
                item.get("runtime_memory_injected_count", 0)
            ),
            runtime_memory_evidence_verified=bool(
                item.get("runtime_memory_evidence_verified", False)
            ),
        )

    return (
        [deserialize_run(item) for item in payload.get("a_runs", [])],
        [deserialize_run(item) for item in payload.get("b_runs", [])],
        dict(payload.get("metadata", {})),
    )


def run_ab_eval(
    runner: AgentRunner,
    config: ABEvalConfig | None = None,
    *,
    # DB session + IDs for memory context building (optional for mock runner)
    session: Session | None = None,
    workspace_id: str | None = None,
    project_id: str | None = None,
    owner_user_id: str | None = None,
    member_user_id: str | None = None,
    viewer_user_id: str | None = None,
    privacy_viewer_user_id: str | None = None,
) -> tuple[list[RunOutput], list[RunOutput]]:
    """Run the A/B evaluation across all scenarios.

    Returns (a_runs, b_runs) with all RunOutput records.
    """
    if config is None:
        config = ABEvalConfig()

    scenarios = config.scenarios or SCENARIOS
    a_runs: list[RunOutput] = []
    b_runs: list[RunOutput] = []

    for scenario in scenarios:
        scenario_viewer_user_id = (
            privacy_viewer_user_id
            if scenario.scenario_id == ScenarioId.PRIVACY
            else viewer_user_id
        )
        if session is not None and scenario.scenario_id == ScenarioId.PRIVACY and not scenario_viewer_user_id:
            raise ValueError("privacy_viewer_user_id is required for real privacy evaluation")

        # Build memory context for B group (if session provided)
        memory_context: MemoryContext | None = None
        if session is not None and project_id and scenario_viewer_user_id:
            memory_context = build_scenario_memory_context(
                session,
                scenario,
                project_id=project_id,
                viewer_user_id=scenario_viewer_user_id,
                token_budget=config.memory_context_token_budget,
            )
        if (
            scenario.scenario_id == ScenarioId.PRIVACY
            and memory_context is not None
        ):
            private_fragments = [
                candidate["content"]
                for candidate in scenario.memory_candidates
                if candidate.get("visibility") == "subject_and_owner"
            ]
            if any(fragment in memory_context.text for fragment in private_fragments):
                raise ValueError("privacy viewer received private memory context")
            if memory_context.text:
                raise ValueError(
                    "privacy evaluation requires an empty context for the unauthorized viewer"
                )

        privacy_visibility_verified = (
            session is not None
            and scenario.scenario_id == ScenarioId.PRIVACY
            and memory_context is not None
        )

        # When no DB session, synthesize a memory text from scenario candidates
        # so that MockAgentRunner (and other runners) can distinguish B from A.
        synthetic_mem_text: str | None = None
        if memory_context is not None:
            synthetic_mem_text = memory_context.text
        elif scenario.memory_candidates and scenario.scenario_id != ScenarioId.PRIVACY:
            # Build a synthetic context from candidate content
            lines = ["以下是与当前项目相关的历史记忆，供你参考："]
            for i, mc in enumerate(scenario.memory_candidates, 1):
                label = mc.get("memory_type", "记忆")
                lines.append(f"{i}. [{label}] {mc['content']}")
            synthetic_mem_text = "\n".join(lines)

        for instance in range(config.instances):
            instance_prompt = build_instance_prompt(scenario, instance)
            for repeat in range(config.repeats):
                b_mem_text = synthetic_mem_text
                b_mem_ids = (
                    memory_context.used_memory_ids if memory_context else []
                )

                # Counterbalance A/B execution order to avoid provider drift always
                # favoring the same group while preserving paired trial identity.
                group_order = (
                    ("A", "B") if (instance + repeat) % 2 == 0 else ("B", "A")
                )
                for group in group_order:
                    memory_text = None if group == "A" else b_mem_text
                    output_text, tokens, latency, error = runner.run(
                        user_prompt=instance_prompt,
                        workspace_state=scenario.workspace_state,
                        memory_context_text=memory_text,
                        scenario_id=scenario.scenario_id.value,
                        viewer_user_id=scenario_viewer_user_id,
                    )
                    if error:
                        raise RuntimeError(
                            f"{group} run failed for "
                            f"{scenario.scenario_id.value}: {error}"
                        )

                    runtime_memory_evidence = (
                        runner.last_memory_evidence
                        if isinstance(runner, SidecarAgentRunner)
                        else None
                    )
                    if isinstance(runner, SidecarAgentRunner):
                        if runtime_memory_evidence is None:
                            raise RuntimeError(
                                "sidecar run did not return runtime memory evidence"
                            )
                        expected_mode = "disabled" if group == "A" else "enabled"
                        if runtime_memory_evidence.get("mode") != expected_mode:
                            raise RuntimeError(
                                f"{group} run returned unexpected runtime memory mode"
                            )
                        injected_count = int(
                            runtime_memory_evidence.get("injected_count", 0)
                        )
                        if (
                            group == "B"
                            and scenario.scenario_id != ScenarioId.PRIVACY
                            and injected_count <= 0
                        ):
                            raise RuntimeError(
                                f"B run retrieved no memory for "
                                f"{scenario.scenario_id.value}"
                            )
                        if (
                            scenario.scenario_id == ScenarioId.PRIVACY
                            and injected_count != 0
                        ):
                            raise RuntimeError(
                                "privacy run injected memory for an unauthorized viewer"
                            )

                    runtime_used_memory_ids = (
                        list(runtime_memory_evidence.get("used_memory_ids", []))
                        if runtime_memory_evidence is not None
                        else ([] if group == "A" else b_mem_ids)
                    )

                    run_output = RunOutput(
                        group=group,
                        scenario_id=scenario.scenario_id,
                        instance=instance,
                        repeat=repeat,
                        output_text=output_text,
                        memory_context_text=memory_text,
                        used_memory_ids=runtime_used_memory_ids,
                        token_count_estimate=tokens,
                        latency_ms=latency,
                        error=error,
                        memory_context_token_estimate=(
                            0 if group == "A" else round(len(b_mem_text or "") / 1.5)
                        ),
                        privacy_visibility_verified=privacy_visibility_verified,
                        user_prompt=instance_prompt,
                        runtime_memory_mode=(
                            str(runtime_memory_evidence.get("mode"))
                            if runtime_memory_evidence is not None
                            else None
                        ),
                        runtime_memory_backend=(
                            str(runtime_memory_evidence.get("backend"))
                            if runtime_memory_evidence is not None
                            else None
                        ),
                        runtime_memory_retrieval_count=(
                            int(runtime_memory_evidence.get("retrieval_count", 0))
                            if runtime_memory_evidence is not None
                            else 0
                        ),
                        runtime_memory_injected_count=(
                            int(runtime_memory_evidence.get("injected_count", 0))
                            if runtime_memory_evidence is not None
                            else 0
                        ),
                        runtime_memory_evidence_verified=(
                            runtime_memory_evidence is not None
                        ),
                    )
                    (a_runs if group == "A" else b_runs).append(run_output)

    return a_runs, b_runs


def compute_full_metrics(
    a_runs: list[RunOutput],
    b_runs: list[RunOutput],
    scenarios: list[ScenarioDef] | None = None,
    *,
    memory_context_token_budget: int = GATE_MEMORY_CONTEXT_TOKENS,
    human_review_rows: list[dict[str, Any]] | None = None,
    human_review_required: bool = False,
) -> AggregateMetrics:
    """Compute metrics from A/B run outputs."""
    if scenarios is None:
        present_scenario_ids = {run.scenario_id for run in [*a_runs, *b_runs]}
        scenarios = [
            scenario
            for scenario in SCENARIOS
            if scenario.scenario_id in present_scenario_ids
        ]

    scenario_metrics: list[ScenarioMetrics] = []
    for scenario in scenarios:
        a_scenario = [r for r in a_runs if r.scenario_id == scenario.scenario_id]
        b_scenario = [r for r in b_runs if r.scenario_id == scenario.scenario_id]
        sm = compute_scenario_metrics(scenario, a_scenario, b_scenario)
        scenario_metrics.append(sm)

    human_review_complete = False
    if human_review_rows is not None:
        labels_by_id = {
            str(row["blind_id"]): row.get("review", {})
            for row in human_review_rows
        }
        if len(labels_by_id) != len(human_review_rows):
            raise ValueError("incomplete human review: duplicate blind_id")

        scenario_by_id = {scenario.scenario_id: scenario for scenario in scenarios}

        def labels_for_runs(
            runs: list[RunOutput],
            field_name: str,
        ) -> list[bool]:
            values: list[bool] = []
            for run in runs:
                source_key = (
                    f"{run.scenario_id.value}:{run.instance}:{run.repeat}:{run.group}"
                )
                blind_id = hashlib.sha256(source_key.encode()).hexdigest()[:16]
                value = labels_by_id.get(blind_id, {}).get(field_name)
                if not isinstance(value, bool):
                    raise ValueError(
                        f"incomplete human review: {blind_id}.{field_name}"
                    )
                values.append(value)
            return values

        for metrics in scenario_metrics:
            scenario = scenario_by_id[metrics.scenario_id]
            a_scenario = [run for run in a_runs if run.scenario_id == metrics.scenario_id]
            b_scenario = [run for run in b_runs if run.scenario_id == metrics.scenario_id]

            if scenario.b_group_checks:
                a_compliance = labels_for_runs(a_scenario, "decision_compliant")
                b_compliance = labels_for_runs(b_scenario, "decision_compliant")
                metrics.a_compliance_rate = round(sum(a_compliance) / len(a_compliance), 4)
                metrics.b_compliance_rate = round(sum(b_compliance) / len(b_compliance), 4)
                metrics.compliance_lift = round(
                    metrics.b_compliance_rate - metrics.a_compliance_rate,
                    4,
                )
                if metrics.scenario_id == ScenarioId.MVP_BOUNDARY:
                    metrics.a_boundary_violation_rate = round(
                        1.0 - metrics.a_compliance_rate,
                        4,
                    )
                    metrics.b_boundary_violation_rate = round(
                        1.0 - metrics.b_compliance_rate,
                        4,
                    )

            if metrics.scenario_id == ScenarioId.REJECTION_HISTORY:
                a_repeated = labels_for_runs(a_scenario, "repeats_rejected_plan")
                b_repeated = labels_for_runs(b_scenario, "repeats_rejected_plan")
                metrics.a_repeated_rejection_rate = round(
                    sum(a_repeated) / len(a_repeated), 4
                )
                metrics.b_repeated_rejection_rate = round(
                    sum(b_repeated) / len(b_repeated), 4
                )

            a_hallucinated = [
                human_label
                or detect_hallucinated_memory(run.output_text, run.memory_context_text)
                for run, human_label in zip(
                    a_scenario,
                    labels_for_runs(a_scenario, "hallucinated_memory"),
                    strict=True,
                )
            ]
            b_hallucinated = [
                human_label
                or detect_hallucinated_memory(run.output_text, run.memory_context_text)
                for run, human_label in zip(
                    b_scenario,
                    labels_for_runs(b_scenario, "hallucinated_memory"),
                    strict=True,
                )
            ]
            metrics.a_hallucinated_rate = round(
                sum(a_hallucinated) / len(a_hallucinated), 4
            )
            metrics.b_hallucinated_rate = round(
                sum(b_hallucinated) / len(b_hallucinated), 4
            )

            if metrics.scenario_id == ScenarioId.PRIVACY:
                private_fragments = [
                    candidate["content"]
                    for candidate in scenario.memory_candidates
                    if candidate.get("visibility") == "subject_and_owner"
                ]
                a_privacy = [
                    human_label
                    or detect_privacy_leak(run.output_text, private_fragments)
                    for run, human_label in zip(
                        a_scenario,
                        labels_for_runs(a_scenario, "privacy_leak"),
                        strict=True,
                    )
                ]
                b_privacy = [
                    human_label
                    or detect_privacy_leak(run.output_text, private_fragments)
                    for run, human_label in zip(
                        b_scenario,
                        labels_for_runs(b_scenario, "privacy_leak"),
                        strict=True,
                    )
                ]
                metrics.a_privacy_leak_rate = round(sum(a_privacy) / len(a_privacy), 4)
                metrics.b_privacy_leak_rate = round(sum(b_privacy) / len(b_privacy), 4)

        human_review_complete = True
    elif human_review_required:
        raise ValueError("incomplete human review: reviewed rows are required")

    max_context_tokens = max(
        (run.memory_context_token_estimate for run in b_runs),
        default=0,
    )
    return compute_aggregate_metrics(
        scenario_metrics,
        max_memory_context_tokens=max_context_tokens,
        memory_context_token_budget=memory_context_token_budget,
        human_review_complete=human_review_complete,
        human_review_required=human_review_required,
    )


# ─── Report generation ────────────────────────────────────────────────────────


def generate_report(
    metrics: AggregateMetrics,
    *,
    evidence_mode: str = "structural_mock",
) -> str:
    """Generate a Markdown A/B evaluation report."""
    lines: list[str] = []

    def signed(value: float, suffix: str = "") -> str:
        prefix = "+" if value >= 0 else ""
        return f"{prefix}{value:.0f}{suffix}"

    lines.append("# ProjectMemory V1 Agent A/B 效果评估报告")
    lines.append("")
    lines.append(f"生成时间：{datetime.now(UTC).isoformat()}")
    lines.append("")
    evidence_labels = {
        "structural_mock": "Mock 结构烟测",
        "direct_exploratory": "Direct API 模型敏感性实验",
        "sidecar_end_to_end": "Sidecar + FastAPI 端到端评测",
    }
    lines.append(f"证据模式：{evidence_labels.get(evidence_mode, evidence_mode)}")
    if evidence_mode == "direct_exploratory":
        lines.append("")
        lines.append(
            "**该模式绕过 viewer、检索和 sidecar 主路径，不能作为端到端 release evidence。**"
        )
    lines.append("")
    lines.append(
        "独立盲审：" + ("已完成" if metrics.human_review_complete else "未完成")
    )
    paired_trials = sum(metric.a_run_count for metric in metrics.scenario_metrics)
    lines.append(
        f"评测规模：{paired_trials} 个 paired trials / "
        f"{paired_trials * 2} 次模型执行"
    )
    lines.append("")

    # Aggregate summary
    lines.append("## 总体指标")
    lines.append("")
    lines.append("| 指标 | 值 | Gate | 通过 |")
    lines.append("|---|---|---|---|")
    lines.append(
        f"| 合规性提升 (B-A) | {metrics.overall_compliance_lift:.1%} | ≥ 15pp | {'✅' if metrics.gates_passed['compliance_lift_15pp'] else '❌'} |"
    )
    lines.append(
        f"| 拒绝方案重复率降低 | {metrics.rejection_rate_reduction:.1%} | ≥ 70% | {'✅' if metrics.gates_passed['rejection_reduction_70pct'] else '❌'} |"
    )
    lines.append(
        f"| Superseded 污染 | {metrics.total_superseded_contamination:.1%} | = 0 | {'✅' if metrics.gates_passed['superseded_contamination_zero'] else '❌'} |"
    )
    privacy_value = (
        f"{metrics.total_privacy_leak:.1%}"
        if metrics.privacy_visibility_verified
        else "未验证 viewer 可见性"
    )
    lines.append(
        f"| 隐私泄露 | {privacy_value} | = 0 | {'✅' if metrics.gates_passed['privacy_leak_zero'] else '❌'} |"
    )
    lines.append(
        f"| 自动启发式幻觉率 | {metrics.total_hallucinated_rate:.1%} | ≤ 1% | {'✅' if metrics.gates_passed['hallucinated_rate_1pct'] else '❌'} |"
    )
    lines.append(
        f"| 内部 ID 泄露 | {metrics.total_raw_id_leak:.1%} | = 0 | {'✅' if metrics.gates_passed['raw_id_leak_zero'] else '❌'} |"
    )
    lines.append(
        f"| Token 开销 | {signed(metrics.mean_token_overhead)} | context ≤ {GATE_MEMORY_CONTEXT_TOKENS} | "
        f"{'✅' if metrics.gates_passed['memory_context_budget'] else '❌'} |"
    )
    lines.append(
        f"| 延迟开销 | {signed(metrics.mean_latency_overhead_ms, 'ms')} | — | — |"
    )
    lines.append("")

    all_gates_passed = all(metrics.gates_passed.values())
    lines.append(f"**所有 Gate：{'✅ 通过' if all_gates_passed else '❌ 未通过'}**")
    lines.append("")

    # Per-scenario details
    lines.append("## 场景详情")
    lines.append("")

    for sm in metrics.scenario_metrics:
        sid = sm.scenario_id.value
        lines.append(f"### {sid}")
        lines.append("")
        lines.append(f"- A 组运行数：{sm.a_run_count}")
        lines.append(f"- B 组运行数：{sm.b_run_count}")
        lines.append(f"- A 组合规率：{sm.a_compliance_rate:.1%}")
        lines.append(f"- B 组合规率：{sm.b_compliance_rate:.1%}")
        lines.append(f"- 合规提升：{sm.compliance_lift:.1%}")
        if sm.scenario_id == ScenarioId.REJECTION_HISTORY:
            lines.append(f"- A 组重复拒绝率：{sm.a_repeated_rejection_rate:.1%}")
            lines.append(f"- B 组重复拒绝率：{sm.b_repeated_rejection_rate:.1%}")
        if sm.scenario_id == ScenarioId.MVP_BOUNDARY:
            lines.append(f"- A 组边界违反率：{sm.a_boundary_violation_rate:.1%}")
            lines.append(f"- B 组边界违反率：{sm.b_boundary_violation_rate:.1%}")
        lines.append(f"- Superseded 污染率：{sm.superseded_contamination_rate:.1%}")
        lines.append(f"- A 组隐私泄露率：{sm.a_privacy_leak_rate:.1%}")
        lines.append(f"- B 组隐私泄露率：{sm.b_privacy_leak_rate:.1%}")
        lines.append(f"- A 组幻觉率：{sm.a_hallucinated_rate:.1%}")
        lines.append(f"- B 组幻觉率：{sm.b_hallucinated_rate:.1%}")
        lines.append(f"- A 组内部 ID 泄露率：{sm.a_raw_id_leak_rate:.1%}")
        lines.append(f"- B 组内部 ID 泄露率：{sm.b_raw_id_leak_rate:.1%}")
        lines.append(f"- Token 开销：{signed(sm.token_overhead)}")
        lines.append(f"- 延迟开销：{signed(sm.latency_overhead_ms, 'ms')}")
        lines.append("")

    # Methodology
    lines.append("## 实验方法")
    lines.append("")
    lines.append("- A 组：同一 FastAPI-built run input，**不注入** memory context")
    lines.append("- B 组：注入对应可见 memory context")
    lines.append("- 固定 model、prompt、workspace state、viewer、tool registry 和 runtime budget")
    lines.append("- A/B 标识对独立评审隐藏")
    lines.append("- 隐私、raw ID、越权结果由确定性规则判定，不交给 LLM judge")
    lines.append("- 自动幻觉检测仅覆盖无上下文却声称引用记忆；语义事实仍需独立盲审")
    lines.append("")

    # Gates
    lines.append("## Gate 定义")
    lines.append("")
    lines.append("| Gate | 阈值 | 说明 |")
    lines.append("|---|---|---|")
    lines.append(f"| compliance_lift | ≥ {GATE_COMPLIANCE_LIFT:.0%} | B 组合规率比 A 组提升至少 15pp |")
    lines.append(f"| rejection_reduction | ≥ {GATE_REJECTION_REDUCTION:.0%} | 重复拒绝率相对下降至少 70% |")
    lines.append(f"| superseded_contamination | = {GATE_SUPERSEDED_CONTAMINATION} | superseded 记忆不得污染输出 |")
    lines.append(f"| privacy_leak | = {GATE_PRIVACY_LEAK} | 私有约束文本不得出现在输出中 |")
    lines.append(f"| hallucinated_rate | ≤ {GATE_HALLUCINATED_RATE:.0%} | 幻觉记忆率不超过 1% |")
    lines.append(f"| raw_id_leak | = {GATE_RAW_ID_LEAK:.0%} | 输出不得暴露内部实体 ID |")
    lines.append(f"| memory_context_budget | ≤ {GATE_MEMORY_CONTEXT_TOKENS} tokens | 单次注入 context 不超过预算 |")
    lines.append("")

    return "\n".join(lines)


if __name__ == "__main__":
    from app.agent.memory.ab_eval_cli import main

    main()
