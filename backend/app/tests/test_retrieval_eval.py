"""Tests for the ProjectMemory V1 Retrieval Evaluation Harness (Issue #76).

Covers acceptance criteria:
- Fixed ProjectMemory fixture set covering direction, boundary, rejection,
  assignment, member constraint, and replan memories
- Default query set with realistic Chinese queries and expected memory IDs
- Harness exercises the service/API retrieval seam (retrieve_memory_ids)
- Default FTS5 retrieval must meet recall@10 >= 90%
- Latency is recorded and asserted under V1 target
- Irrelevant-memory inclusion is flagged
- Runs in default dev/test install without torch, sentence-transformers,
  sqlite-vec, embedding model files, or network downloads
- CI/document verification path runs the default evaluation
- Fixtures include visibility-sensitive cases so evaluation cannot pass by
  bypassing can_view_memory

How to extend the query set without weakening the baseline:
1. Add new entries to DEFAULT_QUERY_SET in retrieval_eval.py with
   expected_fixture_ids referencing EVAL_FIXTURE_SET fixture IDs.
2. New queries must have recall@10 >= 90% on the full set to pass.
3. You may ADD fixtures but must NOT remove or change existing fixture
   content/IDs, as that would break baseline recall.
4. If you must change a fixture, update all query.expected_memory_ids that
   reference it and re-verify recall@10 >= 90%.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.agent.memory.retrieval_eval import (
    DEFAULT_QUERY_SET,
    RECALL_AT_10_TARGET,
    LATENCY_TARGET_MS,
    EvalResult,
    QueryEvalResult,
    check_visibility_enforcement,
    run_retrieval_eval,
    write_eval_fixtures,
    write_cross_project_distractors,
)
from app.agent.memory.retriever import MemoryBackend
from app.agent.memory.query_normalizer import (
    CHINESE_STOP_WORDS,
    normalize_query,
    build_strict_fts_query,
    build_relaxed_fts_query,
    compute_token_coverage,
)
from app.core.database import get_session
from app.main import app
from app.services.memory_service import set_memory_engine


@pytest.fixture(name="engine")
def engine_fixture():
    """Create an in-memory SQLite engine for the eval harness."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)
    set_memory_engine(engine)
    yield engine
    from app.core.database import engine as default_engine

    set_memory_engine(default_engine)


@pytest.fixture(name="session")
def session_fixture(engine):
    with Session(engine) as session:
        yield session


@pytest.fixture(name="client")
def client_fixture(engine):
    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _create_eval_fixture(client: TestClient):
    """Create workspace, project, users and eval memory fixtures."""
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    member = client.post("/api/users", json={"display_name": "小林"}).json()
    outsider = client.post("/api/users", json={"display_name": "Outsider"}).json()

    workspace = client.post(
        "/api/workspaces",
        json={"name": "Eval WS"},
        params={"owner_user_id": owner["id"]},
    ).json()
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": member["id"], "role": "member"},
    )

    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "智慧课表",
            "idea": "解决大学生课表冲突问题的课程规划工具",
            "deadline": "2026-08-15",
            "deliverables": "课表生成器、冲突检测器",
            "created_by": owner["id"],
        },
    ).json()

    return workspace, project, owner, member, outsider


# ─── Core evaluation tests ────────────────────────────────────────────────────


def test_full_eval_suite_meets_recall_target(session: Session, client: TestClient):
    """The default evaluation harness meets recall@10 >= 90% on all queries."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    # All 12 fixtures are written (including dir-expired)
    assert len(fixture_map) == 12
    # R4: query set must have at least 50 queries
    assert len(DEFAULT_QUERY_SET) >= 50

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    # Assert overall recall meets target
    assert result.mean_recall_at_10 >= RECALL_AT_10_TARGET, (
        f"Mean recall@10 {result.mean_recall_at_10:.2%} below target "
        f"{RECALL_AT_10_TARGET:.2%}"
    )
    assert result.min_recall_at_10 >= RECALL_AT_10_TARGET, (
        f"Min recall@10 {result.min_recall_at_10:.2%} below target "
        f"{RECALL_AT_10_TARGET:.2%}"
    )

    # Assert every query has perfect recall (each expected match is within top 10)
    # Exception: typo/noisy queries are allowed to miss (they test robustness, not perfection)
    for qr in result.query_results:
        if qr.slice == "typo_noisy":
            continue  # typo queries may have imperfect recall
        assert qr.recall == 1.0, (
            f"Query '{qr.query_id}' recall={qr.recall:.2%}, "
            f"expected={qr.expected_fixture_ids}, retrieved={qr.retrieved_fixture_ids}"
        )


def test_eval_uses_fts5_backend(session: Session, client: TestClient):
    """All eval queries must use the FTS5 backend in default environment."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    for qr in result.query_results:
        assert qr.backend == MemoryBackend.fts5, (
            f"Query '{qr.query_id}' used backend {qr.backend}, expected fts5"
        )


def test_eval_latency_under_target(session: Session, client: TestClient):
    """Each query must complete within the V1 latency target."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    assert result.max_latency_ms < LATENCY_TARGET_MS, (
        f"Max latency {result.max_latency_ms}ms exceeds target {LATENCY_TARGET_MS}ms"
    )

    for qr in result.query_results:
        assert qr.latency_ms < LATENCY_TARGET_MS, (
            f"Query '{qr.query_id}' latency {qr.latency_ms}ms exceeds target"
        )


def test_expired_fixture_not_retrieved(session: Session, client: TestClient):
    """The expired direction fixture must NOT appear in any retrieval result."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    for qr in result.query_results:
        assert "dir-expired" not in qr.retrieved_fixture_ids, (
            f"Query '{qr.query_id}' incorrectly retrieved expired fixture dir-expired"
        )


def test_irrelevant_memories_flagged(session: Session, client: TestClient):
    """The eval result records which retrieved memories were irrelevant.

    Uses a deliberately broad query (项目) that matches many memories,
    so some retrieved results fall outside the narrow expected set.
    """
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    # Broad query: expect only dir-core but the query "项目" matches almost everything
    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
        queries=[
            {
                "query_id": "q-broad",
                "query": "项目",
                "expected_fixture_ids": {"dir-core"},
                "slice": "test",
            }
        ],
    )

    assert len(result.query_results) == 1
    qr = result.query_results[0]
    # The broad query should retrieve more than just dir-core
    assert len(qr.retrieved_fixture_ids) > len(qr.expected_fixture_ids), (
        f"Broad query should retrieve more than expected. "
        f"Expected={qr.expected_fixture_ids}, Retrieved={qr.retrieved_fixture_ids}"
    )
    assert len(qr.irrelevant_fixture_ids) > 0, (
        f"Broad query should flag at least one irrelevant memory. "
        f"Expected={qr.expected_fixture_ids}, Retrieved={qr.retrieved_fixture_ids}"
    )
    # But recall should still be 100% (dir-core was retrieved)
    assert qr.recall == 1.0, (
        f"Expected fixture dir-core should still be retrieved. "
        f"Recall={qr.recall:.2%}"
    )


# ─── Visibility enforcement tests ─────────────────────────────────────────────


def test_visibility_bypass_prevented_for_outsider(session: Session, client: TestClient):
    """An outsider who is not a workspace member cannot bypass visibility."""
    workspace, project, owner, member, outsider = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    bypass = check_visibility_enforcement(
        session,
        project_id=project["id"],
        outsider_user_id=outsider["id"],
        fixture_id_to_db_id=fixture_map,
    )

    assert not bypass, "Visibility bypass detected: outsider could see subject_and_owner memory"


def test_owner_can_see_subject_and_owner_memory(session: Session, client: TestClient):
    """The owner (owner_user_id_snapshot) can see subject_and_owner memories."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    # The constraint query (q-constraint) should retrieve mc-lin-night for the owner
    for qr in result.query_results:
        if qr.query_id == "q-constraint":
            assert "mc-lin-night" in qr.retrieved_fixture_ids, (
                f"Owner could not see subject_and_owner memory. "
                f"Retrieved: {qr.retrieved_fixture_ids}"
            )


def test_subject_can_see_subject_and_owner_memory(session: Session, client: TestClient):
    """The subject (小林) can see their own subject_and_owner memories."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=member["id"],
        fixture_id_to_db_id=fixture_map,
    )

    # The constraint query should retrieve mc-lin-night for the subject
    for qr in result.query_results:
        if qr.query_id == "q-constraint":
            assert "mc-lin-night" in qr.retrieved_fixture_ids, (
                f"Subject could not see their own subject_and_owner memory. "
                f"Retrieved: {qr.retrieved_fixture_ids}"
            )


# ─── Eval result structure tests ──────────────────────────────────────────────


def test_eval_result_structure_complete(session: Session, client: TestClient):
    """The EvalResult dataclass contains all required metadata fields."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    assert isinstance(result, EvalResult)
    assert result.total_queries == len(DEFAULT_QUERY_SET)
    assert result.fixture_count >= 10  # at least 10 active fixtures
    assert result.mean_recall_at_10 >= 0.0
    assert result.min_recall_at_10 >= 0.0
    assert result.mean_recall_at_3 >= 0.0
    assert result.mean_mrr_at_10 >= 0.0
    assert 0.0 <= result.bad_first_rate <= 1.0
    assert result.max_latency_ms > 0
    assert not result.visibility_bypass_detected

    for qr in result.query_results:
        assert isinstance(qr, QueryEvalResult)
        assert qr.query_id
        assert qr.query
        assert isinstance(qr.expected_fixture_ids, set)
        assert isinstance(qr.retrieved_fixture_ids, set)
        assert 0.0 <= qr.recall <= 1.0
        assert 0.0 <= qr.recall_at_3 <= 1.0
        assert 0.0 <= qr.mrr <= 1.0
        assert qr.latency_ms > 0
        assert qr.backend in (MemoryBackend.fts5, MemoryBackend.sqlite_field, MemoryBackend.none)
        assert isinstance(qr.is_bad_first, bool)
        assert isinstance(qr.slice, str)


def test_query_set_coverage(session: Session, client: TestClient):
    """Every memory_type in the fixture set is covered by at least one query."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    # Collect all fixture_ids that queries expect
    all_expected_fids: set[str] = set()
    for q in DEFAULT_QUERY_SET:
        all_expected_fids.update(q["expected_fixture_ids"])

    # Get memory_type for each expected fixture
    from app.agent.memory.retrieval_eval import EVAL_FIXTURE_SET

    covered_types: set[str] = set()
    for fix in EVAL_FIXTURE_SET:
        if fix["fixture_id"] in all_expected_fids:
            covered_types.add(fix["memory_type"])

    expected_types = {
        "direction", "boundary", "rejection", "assignment",
        "member_constraint", "plan", "tradeoff",
    }

    missing_types = expected_types - covered_types
    assert not missing_types, (
        f"Memory types not covered by any query: {missing_types}"
    )


def test_eval_runs_without_external_deps(session: Session, client: TestClient):
    """The eval harness runs without torch, sentence-transformers, sqlite-vec, etc."""
    # Verify no optional vector deps are importable (they should not be installed)
    optional_deps = ["torch", "sentence_transformers"]
    for dep in optional_deps:
        try:
            __import__(dep)
            has_dep = True
        except ImportError:
            has_dep = False
        assert not has_dep, (
            f"Optional dependency '{dep}' is installed but should not be required "
            f"for the default eval. This test exists to confirm the eval runs "
            f"without these deps."
        )

    # The actual harness run confirms it works without those deps
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    # Should work fine with just jieba + FTS5
    assert result.mean_recall_at_10 >= RECALL_AT_10_TARGET


# ─── R4 query normalizer tests ──────────────────────────────────────────────────


def test_normalize_query_removes_stop_words():
    """Stop words are filtered from queries."""
    tokens = normalize_query("我们的项目方向是什么")
    # "我们", "的", "项目", "是", "什么" are stop words
    assert "我们" not in tokens
    assert "的" not in tokens
    assert "项目" not in tokens
    assert "是" not in tokens
    assert "什么" not in tokens
    # "方向" should remain
    assert "方向" in tokens


def test_normalize_query_deduplicates():
    """Duplicate tokens are removed while preserving order."""
    tokens = normalize_query("方向 方向 边界")
    assert tokens.count("方向") == 1


@pytest.mark.parametrize(
    ("query", "expected_tokens"),
    [
        ("小林什么时候有空做", {"小林", "可用性"}),
        ("后来计划怎么改的", {"计划", "调整"}),
        ("这个课表工具到底有什么用", {"课表", "价值"}),
        ("小林时间", {"小林", "可用性"}),
        ("schema 难题 权衡", {"schema", "问题", "权衡"}),
    ],
)
def test_normalize_query_maps_natural_language_to_memory_vocabulary(
    query: str,
    expected_tokens: set[str],
):
    """Common user wording maps to stable terms used by memory templates."""
    assert expected_tokens.issubset(set(normalize_query(query)))


def test_normalize_query_empty():
    """Empty/whitespace-only queries return empty list."""
    assert normalize_query("") == []
    assert normalize_query("   ") == []


def test_build_strict_fts_query():
    """Strict query joins tokens with implicit AND (space-separated, double-quoted)."""
    result = build_strict_fts_query(["方向", "边界"])
    assert result == '"方向" "边界"'


def test_build_relaxed_fts_query():
    """Relaxed query joins tokens with OR (double-quoted)."""
    result = build_relaxed_fts_query(["方向", "边界"])
    assert result == '"方向" OR "边界"'


def test_compute_token_coverage():
    """Token coverage measures what fraction of query tokens appear in text."""
    text = "项目方向是解决课表冲突问题"
    tokens = ["方向", "课表", "冲突"]
    assert compute_token_coverage(text, tokens) == 1.0  # all 3 present

    tokens2 = ["方向", "课表", "数据库"]
    coverage = compute_token_coverage(text, tokens2)
    assert abs(coverage - 2 / 3) < 0.01  # 2 of 3 present

    assert compute_token_coverage("", tokens) == 0.0
    assert compute_token_coverage(text, []) == 0.0


def test_chinese_stop_words_are_conservative():
    """Stop word list should not include discriminative terms."""
    # These terms should NOT be stop words — they carry retrieval meaning
    not_stop = {"方向", "边界", "分工", "拒绝", "约束", "延期", "权衡", "课表", "冲突", "成员"}
    for word in not_stop:
        assert word not in CHINESE_STOP_WORDS, f"'{word}' should not be a stop word"


# ─── R4 extended metrics tests ──────────────────────────────────────────────────


def test_r4_paraphrase_recall(session: Session, client: TestClient):
    """Paraphrase queries must achieve recall@10 >= 80% (R4 gate)."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    paraphrase_queries = [q for q in DEFAULT_QUERY_SET if q.get("slice") == "paraphrase"]
    assert len(paraphrase_queries) >= 10, "Need at least 10 paraphrase queries"

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
        queries=paraphrase_queries,
    )

    assert result.mean_recall_at_10 >= 0.80, (
        f"Paraphrase recall@10 {result.mean_recall_at_10:.2%} below 80% gate"
    )


def test_r4_overall_metrics(session: Session, client: TestClient):
    """Overall R4 metrics must meet gates: Recall@3 >= 80%, MRR >= 0.75, bad-first <= 2%."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    assert result.mean_recall_at_3 >= 0.80, (
        f"Overall Recall@3 {result.mean_recall_at_3:.2%} below 80% gate"
    )
    assert result.mean_mrr_at_10 >= 0.75, (
        f"Overall MRR@10 {result.mean_mrr_at_10:.2%} below 0.75 gate"
    )
    assert result.bad_first_rate <= 0.02, (
        f"Bad-first rate {result.bad_first_rate:.2%} above 2% gate"
    )


def test_r4_query_slice_coverage():
    """Every required R4 query slice has at least the minimum number of queries."""
    required_slices = {
        "exact_keyword": 10,
        "paraphrase": 10,
        "short_elliptical": 5,
        "typo_noisy": 5,
        "mixed_chinese_english": 5,
        "conflict_lifecycle": 5,
        "project_distractor": 5,
        "privacy_negative": 5,
    }

    slice_counts: dict[str, int] = {}
    for q in DEFAULT_QUERY_SET:
        s = q.get("slice", "unknown")
        slice_counts[s] = slice_counts.get(s, 0) + 1

    for slice_name, min_count in required_slices.items():
        actual = slice_counts.get(slice_name, 0)
        assert actual >= min_count, (
            f"Slice '{slice_name}' has {actual} queries, need at least {min_count}"
        )


# ─── Cross-project contamination in eval harness ──────────────────────────────


def test_cross_project_distractors_do_not_contaminate_retrieval(session: Session, client: TestClient):
    """Distractor memories in a different project must NOT appear in target project retrieval."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    # Create a second project in the same workspace with distractor memories
    distractor_project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "干扰项目",
            "idea": "与目标项目内容高度相似的干扰项目",
            "deadline": "2026-08-15",
            "deliverables": "干扰交付物",
            "created_by": owner["id"],
        },
    ).json()

    distractor_ids = write_cross_project_distractors(
        session,
        workspace_id=workspace["id"],
        distractor_project_id=distractor_project["id"],
        owner_user_id=owner["id"],
    )
    assert len(distractor_ids) > 0, "Should have written distractor memories"

    # Run retrieval on the TARGET project — distractor IDs must NOT appear
    result = run_retrieval_eval(
        session,
        project_id=project["id"],
        viewer_user_id=owner["id"],
        fixture_id_to_db_id=fixture_map,
    )

    # Verify no distractor memory ID appears in the raw retrieval results.
    # Fixture-ID mapping intentionally drops unknown IDs, so checking only
    # retrieved_fixture_ids would hide cross-project contamination.
    for qr in result.query_results:
        leaked_ids = set(qr.retrieved_memory_ids) & set(distractor_ids)
        assert not leaked_ids, (
            f"Query '{qr.query_id}' retrieved distractor memories "
            f"{sorted(leaked_ids)} from another project"
        )

    # Recall should still meet target despite distractors
    assert result.mean_recall_at_10 >= RECALL_AT_10_TARGET


def test_same_workspace_non_subject_member_cannot_see_member_constraint(session: Session, client: TestClient):
    """A workspace member who is NOT the subject or owner cannot see subject_and_owner memories."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    # Add a third member who is neither subject nor owner
    other_member = client.post("/api/users", json={"display_name": "小王"}).json()
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": other_member["id"], "role": "member"},
    )

    fixture_map = write_eval_fixtures(
        session,
        workspace_id=workspace["id"],
        project_id=project["id"],
        owner_user_id=owner["id"],
        member_user_id=member["id"],
    )

    # The other member (小王) should NOT see the member_constraint (mc-lin-night)
    # which has subject_and_owner visibility with subject=小林, owner=Owner
    from app.agent.memory.retriever import retrieve_memory_ids

    result = retrieve_memory_ids(
        session,
        project_id=project["id"],
        query="小林 约束",
        viewer_user_id=other_member["id"],
        limit=10,
    )

    mc_db_id = fixture_map.get("mc-lin-night")
    assert mc_db_id is not None, "mc-lin-night fixture should exist"
    assert mc_db_id not in result.memory_ids, (
        f"Non-subject/non-owner member '{other_member['id']}' should NOT see "
        f"subject_and_owner memory mc-lin-night, but it appeared in retrieval results"
    )

    # The other member SHOULD still see team-visible memories
    asn_backend_id = fixture_map.get("asn-backend")
    if asn_backend_id:
        # Not guaranteed to be in top-10 for this query, but at least
        # the retrieval should succeed without error
        assert result.backend in (MemoryBackend.fts5, MemoryBackend.sqlite_field, MemoryBackend.none)
