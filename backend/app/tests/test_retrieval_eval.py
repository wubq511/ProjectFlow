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
)
from app.agent.memory.retriever import MemoryBackend
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
    for qr in result.query_results:
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
    assert result.max_latency_ms > 0
    assert not result.visibility_bypass_detected

    for qr in result.query_results:
        assert isinstance(qr, QueryEvalResult)
        assert qr.query_id
        assert qr.query
        assert isinstance(qr.expected_fixture_ids, set)
        assert isinstance(qr.retrieved_fixture_ids, set)
        assert 0.0 <= qr.recall <= 1.0
        assert qr.latency_ms > 0
        assert qr.backend in (MemoryBackend.fts5, MemoryBackend.sqlite_field, MemoryBackend.none)


def test_query_set_coverage(session: Session, client: TestClient):
    """Every memory_type in the fixture set is covered by at least one query."""
    workspace, project, owner, member, _ = _create_eval_fixture(client)

    fixture_map = write_eval_fixtures(
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
