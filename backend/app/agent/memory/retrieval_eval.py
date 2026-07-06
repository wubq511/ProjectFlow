"""ProjectMemory V1 Retrieval Evaluation Harness (Issue #76).

Quality guardrail for the default FTS5 retrieval path. Uses fixed Chinese
fixtures and queries to make retrieval quality regressions measurable without
requiring optional vector dependencies.

Design principles:
- Exercises the service/API retrieval seam (retrieve_memory_ids), not private
  tokenizer implementation details.
- Fixtures are deterministic and cover all V1 memory_type values.
- Query set is annotated with expected memory IDs so recall is well-defined.
- Visibility-sensitive cases ensure evaluation cannot pass by bypassing
  can_view_memory.
- Runs in default dev/test install (no torch, sentence-transformers, sqlite-vec,
  embedding model files, or network downloads).

How to extend the query set without weakening the baseline:
1. Add new entries to DEFAULT_QUERY_SET with `expected_memory_ids` that
   reference fixture IDs from EVAL_FIXTURE_SET.
2. New queries must have recall@10 >= 90% on the full set to pass.
3. You may ADD fixtures (new memory_type/content) but must NOT remove or
   change existing fixture content/IDs, as that would break baseline recall.
4. If you must change a fixture, update all query.expected_memory_ids that
   reference it and re-verify recall@10 >= 90%.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import Session

from app.agent.memory.extractor import ProjectMemoryCandidate
from app.agent.memory.retriever import MemoryBackend, RetrievalResult, retrieve_memory_ids
from app.services.memory_service import EXTRACTOR_VERSION, _write_candidates


# ─── Fixture definitions ──────────────────────────────────────────────────────
# Each fixture is a dict describing a ProjectMemory row to write.
# `fixture_id` is a stable symbolic name used in query annotations.
# The actual DB id is generated at write time and stored in the fixture map.

EVAL_FIXTURE_SET: list[dict[str, Any]] = [
    # ── direction ──
    {
        "fixture_id": "dir-core",
        "memory_type": "direction",
        "scope": "project",
        "content": "项目「智慧课表」的核心方向：解决大学生课表冲突问题，服务课程规划学生，交付无冲突课表方案。主要交付物：课表生成器、冲突检测器。",
        "rationale": "方向卡确认时团队明确了项目方向。来源：方向卡确认。",
        "source_type": "direction_card_confirmed",
        "visibility": "team",
    },
    # ── boundary ──
    {
        "fixture_id": "bnd-mvp",
        "memory_type": "boundary",
        "scope": "project",
        "content": "项目「智慧课表」的范围边界：MVP 不包含第三方教务系统对接；不包含移动端推送通知；不包含多学期课表对比。",
        "rationale": "方向卡确认时团队明确了 MVP 和范围边界。来源：方向卡确认。",
        "source_type": "direction_card_confirmed",
        "visibility": "team",
    },
    # ── rejection ──
    {
        "fixture_id": "rej-plan",
        "memory_type": "rejection",
        "scope": "project",
        "content": "项目「智慧课表」的阶段计划方案未被采纳。",
        "rationale": "拒绝理由：第一阶段范围过大，需要拆分为更小的迭代。来源：方案拒绝。",
        "source_type": "proposal_rejected",
        "visibility": "team",
    },
    # ── assignment ──
    {
        "fixture_id": "asn-backend",
        "memory_type": "assignment",
        "scope": "task",
        "content": "项目「智慧课表」的「后端 API 与数据模型」任务由小林负责。分工理由：小林有 FastAPI 经验且本周可用时间充足。",
        "rationale": "分工确认时团队明确了任务负责人。来源：分工确认。",
        "source_type": "assignment_confirmed",
        "visibility": "team",
    },
    # ── member_constraint (subject_and_owner visibility) ──
    {
        "fixture_id": "mc-lin-night",
        "memory_type": "member_constraint",
        "scope": "member",
        "content": "小林的约束：只能晚上和周末工作。来源：项目「智慧课表」的分工确认。",
        "rationale": "分工确认时捕获了成员的可用性或偏好约束。来源：分工确认。",
        "source_type": "assignment_confirmed",
        "visibility": "subject_and_owner",
        "subject_fixture_key": "member",  # resolved at write time
        "owner_fixture_key": "owner",     # resolved at write time
    },
    # ── plan (from replan) ──
    {
        "fixture_id": "plan-replan1",
        "memory_type": "plan",
        "scope": "project",
        "content": "项目「智慧课表」的计划已调整：第二阶段延期一周，前端任务提前启动。",
        "rationale": "重排理由：后端 API 开发遇到数据库 schema 难题，需要额外时间。来源：重排确认。",
        "source_type": "replan_confirmed",
        "visibility": "team",
    },
    # ── tradeoff (from replan) ──
    {
        "fixture_id": "to-replan1",
        "memory_type": "tradeoff",
        "scope": "project",
        "content": "项目「智慧课表」的重排权衡：「后端开发」：延期以解决 schema 问题；「前端页面」：提前启动以并行推进。",
        "rationale": "重排确认时团队对阶段和任务进行了调整。来源：重排确认。",
        "source_type": "replan_confirmed",
        "visibility": "team",
    },
    # ── boundary (from replan) ──
    {
        "fixture_id": "bnd-replan1",
        "memory_type": "boundary",
        "scope": "project",
        "content": "项目「智慧课表」的范围调整：涉及「国际化支持」等任务，为控制范围砍掉了低优先级功能。",
        "rationale": "重排确认时团队对任务范围和优先级进行了调整。来源：重排确认。",
        "source_type": "replan_confirmed",
        "visibility": "team",
    },
    # ── second direction (diversity) ──
    {
        "fixture_id": "dir-value",
        "memory_type": "direction",
        "scope": "project",
        "content": "项目「智慧课表」的核心价值：帮助学生在五分钟内生成无冲突课表，减少手动试错时间。",
        "rationale": "方向卡确认时团队明确了项目方向。来源：方向卡确认。",
        "source_type": "direction_card_confirmed",
        "visibility": "team",
    },
    # ── second assignment ──
    {
        "fixture_id": "asn-frontend",
        "memory_type": "assignment",
        "scope": "task",
        "content": "项目「智慧课表」的「前端课表展示页面」任务由小王负责。分工理由：小王熟悉 React 和 Tailwind CSS。",
        "rationale": "分工确认时团队明确了任务负责人。来源：分工确认。",
        "source_type": "assignment_confirmed",
        "visibility": "team",
    },
    # ── second rejection (replan rejected) ──
    {
        "fixture_id": "rej-replan",
        "memory_type": "rejection",
        "scope": "project",
        "content": "项目「智慧课表」的重排方案未被采纳。",
        "rationale": "拒绝理由：提议砍掉测试任务风险太高，团队不同意。来源：重排方案拒绝。",
        "source_type": "replan_rejected",
        "visibility": "team",
    },
    # ── expired direction (should NOT be retrieved) ──
    {
        "fixture_id": "dir-expired",
        "memory_type": "direction",
        "scope": "project",
        "content": "项目「智慧课表」的旧方向：只做单学期课表。",
        "rationale": "方向卡确认时团队明确了项目方向。来源：方向卡确认。",
        "source_type": "direction_card_confirmed",
        "visibility": "team",
        "valid_until": "expired",  # resolved at write time to now - 1 day
    },
]


# ─── Query definitions ────────────────────────────────────────────────────────
# Each query has a Chinese query string and a set of expected fixture_ids.
# recall@10 is computed as |retrieved ∩ expected| / |expected|.

DEFAULT_QUERY_SET: list[dict[str, Any]] = [
    {
        "query_id": "q-direction",
        "query": "项目核心方向",
        "expected_fixture_ids": {"dir-core", "dir-value"},
    },
    {
        "query_id": "q-boundary-mvp",
        "query": "MVP 范围边界",
        "expected_fixture_ids": {"bnd-mvp"},
    },
    {
        "query_id": "q-boundary-replan",
        "query": "范围调整 任务砍掉",
        "expected_fixture_ids": {"bnd-replan1"},
    },
    {
        "query_id": "q-rejection-plan",
        "query": "方案未被采纳 拒绝理由",
        "expected_fixture_ids": {"rej-plan", "rej-replan"},
    },
    {
        "query_id": "q-assignment-backend",
        "query": "小林 后端 API 分工",
        "expected_fixture_ids": {"asn-backend"},
    },
    {
        "query_id": "q-assignment-frontend",
        "query": "小王 前端 课表展示",
        "expected_fixture_ids": {"asn-frontend"},
    },
    {
        "query_id": "q-constraint",
        "query": "小林 约束 只能晚上",
        "expected_fixture_ids": {"mc-lin-night"},
    },
    {
        "query_id": "q-replan-plan",
        "query": "计划调整 延期 重排",
        "expected_fixture_ids": {"plan-replan1"},
    },
    {
        "query_id": "q-tradeoff",
        "query": "重排权衡 schema 延期",
        "expected_fixture_ids": {"to-replan1"},
    },
    {
        "query_id": "q-value",
        "query": "核心价值 五分钟 无冲突",
        "expected_fixture_ids": {"dir-value"},
    },
]


# ─── Evaluation result types ──────────────────────────────────────────────────


@dataclass
class QueryEvalResult:
    """Result of evaluating a single query."""

    query_id: str
    query: str
    expected_fixture_ids: set[str]
    retrieved_fixture_ids: set[str]
    recall: float  # |retrieved ∩ expected| / |expected|
    latency_ms: float
    backend: MemoryBackend
    irrelevant_fixture_ids: set[str]  # retrieved but not expected


@dataclass
class EvalResult:
    """Aggregate result of the full evaluation harness."""

    query_results: list[QueryEvalResult]
    mean_recall_at_10: float
    min_recall_at_10: float
    max_latency_ms: float
    total_queries: int
    fixture_count: int
    visibility_bypass_detected: bool  # True if visibility was bypassed


# ─── V1 targets ───────────────────────────────────────────────────────────────

RECALL_AT_10_TARGET = 0.90  # 90%
LATENCY_TARGET_MS = 500.0  # 500ms per query (generous for SQLite FTS5)


# ─── Harness implementation ───────────────────────────────────────────────────


def write_eval_fixtures(
    session: Session,
    *,
    workspace_id: str,
    project_id: str,
    owner_user_id: str,
    member_user_id: str,
) -> dict[str, str]:
    """Write the fixed fixture set and return a mapping fixture_id → db_memory_id.

    This function is idempotent within a test session: each fixture gets a
    unique source_id so repeated calls create new rows (tests use fresh DBs).
    """
    fixture_id_to_db_id: dict[str, str] = {}

    for fixture in EVAL_FIXTURE_SET:
        fid = fixture["fixture_id"]

        # Resolve visibility-specific fields
        subject_user_id = None
        owner_user_id_snapshot = None
        if fixture.get("subject_fixture_key") == "member":
            subject_user_id = member_user_id
        if fixture.get("owner_fixture_key") == "owner":
            owner_user_id_snapshot = owner_user_id

        # Resolve valid_until
        valid_until = None
        if fixture.get("valid_until") == "expired":
            valid_until = datetime.now(UTC) - timedelta(days=1)

        candidate = ProjectMemoryCandidate(
            memory_type=fixture["memory_type"],
            scope=fixture["scope"],
            content=fixture["content"],
            rationale=fixture["rationale"],
            source_type=fixture["source_type"],
            source_id=str(uuid.uuid4()),  # unique per write
            source_hash="eval-" + fid + "-" + str(uuid.uuid4()),
            visibility=fixture["visibility"],
            subject_user_id=subject_user_id,
            owner_user_id_snapshot=owner_user_id_snapshot,
            valid_until=valid_until,
        )

        written = _write_candidates(
            session,
            workspace_id=workspace_id,
            project_id=project_id,
            candidates=[candidate],
            extractor_version=EXTRACTOR_VERSION,
        )
        session.commit()

        if written:
            fixture_id_to_db_id[fid] = written[0].id

    return fixture_id_to_db_id


def run_retrieval_eval(
    session: Session,
    *,
    project_id: str,
    viewer_user_id: str,
    fixture_id_to_db_id: dict[str, str],
    queries: list[dict[str, Any]] | None = None,
    recall_target: float = RECALL_AT_10_TARGET,
    latency_target_ms: float = LATENCY_TARGET_MS,
) -> EvalResult:
    """Run the retrieval evaluation harness.

    Args:
        session: DB session with fixtures already written.
        project_id: Project ID for retrieval.
        viewer_user_id: Viewer who can see team-visible memories.
        fixture_id_to_db_id: Mapping from fixture_id to actual DB memory ID.
        queries: Query set to evaluate (defaults to DEFAULT_QUERY_SET).
        recall_target: Minimum acceptable recall@10.
        latency_target_ms: Maximum acceptable latency per query.

    Returns:
        EvalResult with per-query and aggregate metrics.
    """
    if queries is None:
        queries = DEFAULT_QUERY_SET

    # Build reverse map: db_id → fixture_id
    db_id_to_fixture_id: dict[str, str] = {
        v: k for k, v in fixture_id_to_db_id.items()
    }

    query_results: list[QueryEvalResult] = []

    for q in queries:
        expected_fids = set(q["expected_fixture_ids"])

        start = time.perf_counter()
        result: RetrievalResult = retrieve_memory_ids(
            session,
            project_id=project_id,
            query=q["query"],
            viewer_user_id=viewer_user_id,
            limit=10,
        )
        latency_ms = (time.perf_counter() - start) * 1000

        # Map retrieved DB IDs back to fixture IDs
        retrieved_fids: set[str] = set()
        for db_id in result.memory_ids:
            fid = db_id_to_fixture_id.get(db_id)
            if fid is not None:
                retrieved_fids.add(fid)

        # Compute recall
        if expected_fids:
            hit_count = len(retrieved_fids & expected_fids)
            recall = hit_count / len(expected_fids)
        else:
            recall = 1.0  # no expectations → vacuously correct

        # Irrelevant = retrieved but not in expected
        irrelevant = retrieved_fids - expected_fids

        query_results.append(
            QueryEvalResult(
                query_id=q["query_id"],
                query=q["query"],
                expected_fixture_ids=expected_fids,
                retrieved_fixture_ids=retrieved_fids,
                recall=recall,
                latency_ms=round(latency_ms, 2),
                backend=result.backend,
                irrelevant_fixture_ids=irrelevant,
            )
        )

    # Aggregate
    recalls = [qr.recall for qr in query_results]
    mean_recall = sum(recalls) / len(recalls) if recalls else 0.0
    min_recall = min(recalls) if recalls else 0.0
    max_latency = max(qr.latency_ms for qr in query_results) if query_results else 0.0

    return EvalResult(
        query_results=query_results,
        mean_recall_at_10=round(mean_recall, 4),
        min_recall_at_10=round(min_recall, 4),
        max_latency_ms=round(max_latency, 2),
        total_queries=len(query_results),
        fixture_count=len(fixture_id_to_db_id),
        visibility_bypass_detected=False,  # set by caller after visibility check
    )


def check_visibility_enforcement(
    session: Session,
    *,
    project_id: str,
    outsider_user_id: str,
    fixture_id_to_db_id: dict[str, str],
) -> bool:
    """Verify that subject_and_owner memories are NOT visible to outsiders.

    Returns True if a visibility bypass is detected (bad), False if enforcement
    is correct (good).
    """
    # The outsider should not be a workspace member, so retrieve_memory_ids
    # should raise ValueError (validate_viewer rejects non-members).
    # If it doesn't raise, that's a bypass.
    try:
        result = retrieve_memory_ids(
            session,
            project_id=project_id,
            query="小林 约束",
            viewer_user_id=outsider_user_id,
            limit=10,
        )
        # If we get here without ValueError, check if the member_constraint
        # memory was returned — that would be a bypass.
        mc_db_id = fixture_id_to_db_id.get("mc-lin-night")
        if mc_db_id and mc_db_id in result.memory_ids:
            return True  # bypass detected!
    except ValueError:
        pass  # expected: outsider is not a workspace member

    return False  # no bypass
