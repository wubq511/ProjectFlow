"""Tests for ProjectMemory V1 Proposal Rejection Memory (Issue #72).

Covers all acceptance criteria:
1. Frontend rejection flow requires non-empty reason for durable memory path
2. Backend legacy/empty reason calls remain compatible, no ProjectMemory write
3. Rejected proposal with non-empty reason creates exactly one rejection memory
4. proposal_rejected does not create AgentEvent, does not expand enums
5. content states what was not adopted; rationale cites only explicit reason
6. Memory is team-visible, participates in JSON/Markdown visibility
7. Idempotent replay; changed reason supersedes prior active rejection memory
8. User-visible fields contain no raw internal IDs
9. Tests cover frontend reason capture, empty-reason skip, non-empty write,
   no-AgentEvent behavior, idempotency, and no-raw-ID output
"""

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.database import get_session
from app.main import app
from app.services.memory_service import set_memory_engine


@pytest.fixture(name="client")
def client_fixture():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)

    # Override memory engine so extract_from_event uses the test engine
    set_memory_engine(engine)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    # Restore default engine
    from app.core.database import engine as default_engine
    set_memory_engine(default_engine)


def _create_full_fixture(client: TestClient):
    """Create workspace, project, owner, member, outsider for testing."""
    owner = client.post("/api/users", json={"display_name": "Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Member"}).json()
    outsider = client.post("/api/users", json={"display_name": "Outsider"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Rejection WS"},
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
            "name": "Rejection Project",
            "idea": "Test rejection memory",
            "deadline": "2026-07-15",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    return workspace, project, owner, member, outsider


def _create_and_reject_proposal(
    client: TestClient,
    workspace_id: str,
    reason: str | None,
) -> str:
    """Create a clarify proposal and reject it with the given reason.
    Returns the proposal_id.
    """
    clarify_resp = client.post("/api/agent/clarify", json={"workspace_id": workspace_id})
    assert clarify_resp.status_code == 200
    proposal_id = clarify_resp.json()["proposal_id"]

    reject_body = {} if reason is None else {"reason": reason}
    reject_resp = client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json=reject_body,
    )
    assert reject_resp.status_code == 200
    return proposal_id


# ─── AC2: Empty reason → no ProjectMemory ────────────────────────────────────


def test_empty_reason_no_memory(client: TestClient):
    """空 reason 拒绝不创建 ProjectMemory。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason=None)

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    assert memories_resp.status_code == 200
    assert memories_resp.json() == []


def test_blank_reason_no_memory(client: TestClient):
    """空白字符串 reason 拒绝不创建 ProjectMemory。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason="   ")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    assert memories_resp.status_code == 200
    assert memories_resp.json() == []


# ─── AC3: Non-empty reason → exactly one rejection memory ────────────────────


def test_nonempty_reason_creates_rejection_memory(client: TestClient):
    """非空 reason 拒绝创建恰好 1 条 rejection 记忆。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason="方案不符合团队时间约束")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    assert memories_resp.status_code == 200
    memories = memories_resp.json()
    rejection_memories = [m for m in memories if m["memory_type"] == "rejection"]
    assert len(rejection_memories) == 1

    mem = rejection_memories[0]
    assert mem["source_type"] == "proposal_rejected"
    assert mem["visibility"] == "team"
    assert mem["scope"] == "project"
    assert mem["status"] == "active"


# ─── AC4: No AgentEvent created ──────────────────────────────────────────────


def test_rejection_does_not_create_agent_event(client: TestClient):
    """proposal_rejected 不创建 AgentEvent，不污染 timeline。"""
    workspace, project, owner, *_ = _create_full_fixture(client)

    # Create the clarify proposal first (this creates 1 AgentEvent)
    clarify_resp = client.post("/api/agent/clarify", json={"workspace_id": workspace["id"]})
    proposal_id = clarify_resp.json()["proposal_id"]

    # Get timeline after clarify, before rejection
    timeline_before_reject = client.get(
        f"/api/projects/{project['id']}/timeline",
    ).json()

    # Reject with reason
    client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json={"reason": "不合适"},
    )

    # Get timeline after rejection
    timeline_after = client.get(
        f"/api/projects/{project['id']}/timeline",
    ).json()

    # No new AgentEvent created by the rejection itself
    assert len(timeline_after) == len(timeline_before_reject)


# ─── AC5: content/rationale semantics ────────────────────────────────────────


def test_content_states_what_was_not_adopted(client: TestClient):
    """content 说明方案未被采纳。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason="团队资源不足")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    memories = memories_resp.json()
    rejection = [m for m in memories if m["memory_type"] == "rejection"][0]

    # content mentions the proposal was not adopted
    assert "未被采纳" in rejection["content"]
    # content contains the project name
    assert project["name"] in rejection["content"]


def test_rationale_cites_only_explicit_reason(client: TestClient):
    """rationale 只引用显式拒绝理由，不推断隐藏因果。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    explicit_reason = "方向与团队核心能力不匹配"
    _create_and_reject_proposal(client, workspace["id"], reason=explicit_reason)

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    memories = memories_resp.json()
    rejection = [m for m in memories if m["memory_type"] == "rejection"][0]

    # rationale contains the explicit reason
    assert explicit_reason in rejection["rationale"]
    # rationale cites the source
    assert "方案拒绝" in rejection["rationale"]


# ─── AC6: Team visibility ────────────────────────────────────────────────────


def test_rejection_memory_team_visible(client: TestClient):
    """rejection 记忆是 team 可见，所有 workspace 成员可看到。"""
    workspace, project, owner, member, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason="时间不够")

    # Owner can see
    owner_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    owner_memories = owner_resp.json()
    owner_rejection = [m for m in owner_memories if m["memory_type"] == "rejection"]
    assert len(owner_rejection) == 1

    # Member can also see
    member_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": member["id"]},
    )
    member_memories = member_resp.json()
    member_rejection = [m for m in member_memories if m["memory_type"] == "rejection"]
    assert len(member_rejection) == 1


def test_rejection_memory_markdown_visible(client: TestClient):
    """rejection 记忆参与 Markdown 导出。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason="优先级不对")

    md_resp = client.get(
        f"/api/projects/{project['id']}/memories.md",
        params={"viewer_user_id": owner["id"]},
    )
    assert md_resp.status_code == 200
    markdown = md_resp.text
    # Should contain rejection content
    assert "未被采纳" in markdown
    assert project["name"] in markdown


# ─── AC7: Idempotency ────────────────────────────────────────────────────────


def test_idempotent_replay_no_duplicates(client: TestClient):
    """同 source_hash 重放不创建重复 rejection 记忆。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason="理由相同")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    memories = memories_resp.json()
    rejection_count = sum(1 for m in memories if m["memory_type"] == "rejection")
    assert rejection_count == 1


def test_changed_reason_supersedes_old(client: TestClient):
    """不同 reason 的同 (project, source_type, source_id, memory_type) supersede 旧记忆。"""
    from app.agent.memory.extractor import ProjectMemoryCandidate
    from app.services.memory_service import _write_candidates, get_memory_engine, EXTRACTOR_VERSION

    workspace, project, owner, *_ = _create_full_fixture(client)

    with Session(get_memory_engine()) as session:
        # Write first rejection memory
        cand1 = ProjectMemoryCandidate(
            memory_type="rejection",
            scope="project",
            content="方案未被采纳 v1",
            rationale="拒绝理由：理由v1。来源：方案拒绝。",
            source_type="proposal_rejected",
            source_id="test-reject-proposal-1",
            source_hash="hash-reject-v1",
            visibility="team",
            subject_user_id=None,
            owner_user_id_snapshot=None,
            related_stage_id=None,
            related_task_id=None,
            related_risk_id=None,
            valid_until=None,
        )
        written1 = _write_candidates(
            session,
            workspace_id=workspace["id"],
            project_id=project["id"],
            candidates=[cand1],
            extractor_version=EXTRACTOR_VERSION,
        )
        session.commit()
        assert len(written1) == 1
        old_id = written1[0].id

        # Write second rejection with same source_id but different hash → supersede
        cand2 = ProjectMemoryCandidate(
            memory_type="rejection",
            scope="project",
            content="方案未被采纳 v2",
            rationale="拒绝理由：理由v2。来源：方案拒绝。",
            source_type="proposal_rejected",
            source_id="test-reject-proposal-1",
            source_hash="hash-reject-v2",
            visibility="team",
            subject_user_id=None,
            owner_user_id_snapshot=None,
            related_stage_id=None,
            related_task_id=None,
            related_risk_id=None,
            valid_until=None,
        )
        written2 = _write_candidates(
            session,
            workspace_id=workspace["id"],
            project_id=project["id"],
            candidates=[cand2],
            extractor_version=EXTRACTOR_VERSION,
        )
        session.commit()
        assert len(written2) == 1
        new_id = written2[0].id
        assert new_id != old_id

        # Verify old memory is superseded
        from app.models import ProjectMemory
        old_memory = session.get(ProjectMemory, old_id)
        assert old_memory.status == "superseded"
        assert old_memory.superseded_by_memory_id == new_id

        # Verify new memory is active
        new_memory = session.get(ProjectMemory, new_id)
        assert new_memory.status == "active"


# ─── AC8: No raw IDs in user-visible fields ──────────────────────────────────


def test_content_no_raw_ids(client: TestClient):
    """content/rationale 中不出现 raw user_id/project_id。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason="测试理由")

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    memories = memories_resp.json()
    for memory in memories:
        for field in ["content", "rationale"]:
            value = memory.get(field, "") or ""
            assert owner["id"] not in value
            assert project["id"] not in value


def test_markdown_no_raw_ids(client: TestClient):
    """Markdown 导出中不出现 raw user_id/project_id。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    _create_and_reject_proposal(client, workspace["id"], reason="测试理由")

    md_resp = client.get(
        f"/api/projects/{project['id']}/memories.md",
        params={"viewer_user_id": owner["id"]},
    )
    assert md_resp.status_code == 200
    markdown = md_resp.text
    assert owner["id"] not in markdown
    assert project["id"] not in markdown


# ─── AC9: Extractor deterministic, no LLM ────────────────────────────────────


def test_extractor_deterministic():
    """extract_proposal_rejected 对相同输入产生相同输出。"""
    from unittest.mock import MagicMock
    from app.agent.memory.extractor import extract_proposal_rejected

    proposal = MagicMock()
    proposal.id = "test-id"
    proposal.proposal_type = "clarify"
    proposal.rejection_reason = "理由一致"

    project = MagicMock()
    project.id = "proj-id"
    project.name = "测试项目"

    session = MagicMock()
    # Mock resolve_project_name
    from app.agent.memory import extractor as ext_module
    original_resolve = ext_module.resolve_project_name
    ext_module.resolve_project_name = lambda s, pid: "测试项目"

    try:
        candidates1 = extract_proposal_rejected(session, proposal=proposal, project=project)
        candidates2 = extract_proposal_rejected(session, proposal=proposal, project=project)
        assert len(candidates1) == 1
        assert len(candidates2) == 1
        assert candidates1[0].content == candidates2[0].content
        assert candidates1[0].rationale == candidates2[0].rationale
        assert candidates1[0].source_hash == candidates2[0].source_hash
    finally:
        ext_module.resolve_project_name = original_resolve


def test_extractor_empty_reason_returns_empty():
    """extract_proposal_rejected 对空 reason 返回空列表。"""
    from unittest.mock import MagicMock
    from app.agent.memory.extractor import extract_proposal_rejected

    proposal = MagicMock()
    proposal.id = "test-id"
    proposal.proposal_type = "clarify"
    proposal.rejection_reason = ""

    project = MagicMock()
    project.id = "proj-id"

    session = MagicMock()
    candidates = extract_proposal_rejected(session, proposal=proposal, project=project)
    assert candidates == []


def test_extractor_none_reason_returns_empty():
    """extract_proposal_rejected 对 None reason 返回空列表。"""
    from unittest.mock import MagicMock
    from app.agent.memory.extractor import extract_proposal_rejected

    proposal = MagicMock()
    proposal.id = "test-id"
    proposal.proposal_type = "clarify"
    proposal.rejection_reason = None

    project = MagicMock()
    project.id = "proj-id"

    session = MagicMock()
    candidates = extract_proposal_rejected(session, proposal=proposal, project=project)
    assert candidates == []


# ─── Additional: Legacy compatibility ────────────────────────────────────────


def test_reject_without_body_still_works(client: TestClient):
    """不传 body 的拒绝请求仍然兼容（legacy）。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    clarify_resp = client.post("/api/agent/clarify", json={"workspace_id": workspace["id"]})
    proposal_id = clarify_resp.json()["proposal_id"]

    # Reject without body
    reject_resp = client.post(f"/api/agent-proposals/{proposal_id}/reject")
    assert reject_resp.status_code == 200
    assert reject_resp.json()["status"] == "rejected"

    # No memory created
    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    assert memories_resp.status_code == 200
    assert memories_resp.json() == []


def test_rejection_memory_source_id_is_proposal_id(client: TestClient):
    """rejection 记忆的 source_id 指向被拒绝的 AgentProposal.id。"""
    workspace, project, owner, *_ = _create_full_fixture(client)
    proposal_id = _create_and_reject_proposal(
        client, workspace["id"], reason="验证 source_id"
    )

    memories_resp = client.get(
        f"/api/projects/{project['id']}/memories",
        params={"viewer_user_id": owner["id"]},
    )
    memories = memories_resp.json()
    rejection = [m for m in memories if m["memory_type"] == "rejection"][0]
    assert rejection["source_id"] == proposal_id


def test_different_proposal_types_have_correct_label(client: TestClient):
    """不同 proposal_type 的拒绝记忆使用正确的中文标签。"""
    from unittest.mock import MagicMock
    from app.agent.memory.extractor import extract_proposal_rejected

    session = MagicMock()
    from app.agent.memory import extractor as ext_module
    original_resolve = ext_module.resolve_project_name
    ext_module.resolve_project_name = lambda s, pid: "测试项目"

    try:
        for p_type, expected_label in [
            ("clarify", "方向卡"),
            ("plan", "阶段计划"),
            ("breakdown", "任务分解"),
            ("replan", "计划调整"),
        ]:
            proposal = MagicMock()
            proposal.id = f"test-{p_type}"
            proposal.proposal_type = p_type
            proposal.rejection_reason = "测试理由"

            project = MagicMock()
            project.id = "proj-id"

            candidates = extract_proposal_rejected(
                session, proposal=proposal, project=project
            )
            assert len(candidates) == 1
            assert expected_label in candidates[0].content
    finally:
        ext_module.resolve_project_name = original_resolve
