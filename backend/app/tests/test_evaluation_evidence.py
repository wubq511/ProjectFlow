"""T46-2 Evaluation Evidence Snapshot tests.

Covers Issue #95 acceptance criteria for the normalized evidence snapshot:

1. Authentication requires BOTH internal service token AND evaluator-owned
   instance identity (nonce + instance ID + ownership marker + path containment).
2. Snapshot is read-only — it never mutates database state.
3. Snapshot is viewer-scoped — private conversations and subject_and_owner
   ProjectMemory content are filtered by the same authorization predicates
   used by public read endpoints.
4. Snapshot is normalized — no raw payload values, no input/output snapshot
   blobs, no trace payloads, no absolute paths, no secrets.
5. trajectory/side_effect/metric/context_receipt facts are returned only when
   run_id is provided.
"""

from __future__ import annotations

import hashlib
import json
import os

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.config import settings as app_settings
from app.core.database import get_session
from app.main import app
from app.models import AgentMessage, ProjectMemory
from app.models.agent_run_state import AgentRunEvent, AgentRunV2
from app.services.memory_service import set_memory_engine


NONCE = "evidence-nonce"
INSTANCE_ID = "evidence-instance-001"
INTERNAL_TOKEN = "test-internal-service-token"


def _evaluation_headers(
    *,
    nonce: str = NONCE,
    instance_id: str = INSTANCE_ID,
    internal_token: str = INTERNAL_TOKEN,
) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {internal_token}",
        "X-Evaluation-Nonce": nonce,
        "X-Evaluation-Instance-Id": instance_id,
    }


def _configure_evaluation_env(monkeypatch, temp_root: str) -> None:
    """Configure evaluation env so the evidence endpoint accepts requests.

    Patches:
    - app_env = "evaluation"
    - nonce / instance_id matching the marker
    - database_url pointing inside temp_root (path containment)
    - upload_dir inside temp_root
    """
    monkeypatch.setattr(app_settings, "app_env", "evaluation")
    monkeypatch.setattr(
        app_settings, "evaluation_nonce", SecretStr(NONCE), raising=False
    )
    monkeypatch.setattr(
        app_settings,
        "evaluation_instance_id",
        SecretStr(INSTANCE_ID),
        raising=False,
    )
    monkeypatch.setattr(
        app_settings, "evaluation_temp_root", temp_root, raising=False
    )
    monkeypatch.setattr(
        app_settings,
        "database_url",
        f"sqlite:///{os.path.join(temp_root, 'projectflow.sqlite')}",
    )
    upload_dir = os.path.join(temp_root, "uploads")
    os.makedirs(upload_dir, exist_ok=True)
    monkeypatch.setattr(app_settings, "upload_dir", upload_dir)


def _write_marker(temp_root: str) -> None:
    marker_path = os.path.join(temp_root, ".evaluator-ownership-marker")
    with open(marker_path, "w", encoding="utf-8") as f:
        json.dump({"nonce": NONCE, "instanceId": INSTANCE_ID}, f)


@pytest.fixture(name="client")
def client_fixture():
    """In-memory SQLite TestClient with all tables created.

    Note: the engine is in-memory, but the evaluation security check reads
    ``settings.database_url`` which we monkeypatch to a path inside temp_root
    for path containment. The handler then uses ``get_session`` (overridden to
    the in-memory engine) for actual queries. This mirrors the pattern in
    ``test_evaluation_security.py``.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)
    set_memory_engine(engine)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    from app.core.database import engine as default_engine
    set_memory_engine(default_engine)


def _seed_fixture(client: TestClient) -> dict[str, str]:
    """Seed a workspace with two members, a project, stage, task, and conversations.

    Returns a dict of IDs:
    - owner_id (also conversation B creator)
    - member_id (also conversation A creator)
    - outsider_id (not a workspace member)
    - workspace_id, project_id, stage_id, task_id
    - team_conv_id, private_conv_a_id (created by member)
    - private_conv_b_id (created by owner)
    """
    owner = client.post("/api/users", json={"display_name": "项目负责人"}).json()
    member = client.post("/api/users", json={"display_name": "小林"}).json()
    outsider = client.post("/api/users", json={"display_name": "局外人"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Evidence WS"},
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
            "name": "证据快照项目",
            "idea": "Test evidence snapshot normalization",
            "deadline": "2026-08-15",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "开发阶段",
            "goal": "完成核心开发",
            "start_date": "2026-07-01",
            "end_date": "2026-07-10",
            "deliverable": "核心功能",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "后端 API 与数据模型",
            "description": "实现 RESTful API 和数据库模型",
            "priority": "P0",
            "due_date": "2026-07-10",
        },
    ).json()

    # Create conversations directly via service to control visibility.
    # We use create_conversation() to validate viewer membership, then flip
    # the team conversation to visibility="team" and append messages directly
    # via the AgentMessage model (no sidecar round-trip needed for tests).
    from app.services.agent_conversation_service import create_conversation

    sess = next(app.dependency_overrides[get_session]())

    def _add_message(conversation_id: str, role: str, content: str) -> None:
        sess.add(AgentMessage(conversation_id=conversation_id, role=role, content=content))
        sess.commit()

    team_conv = create_conversation(
        sess, project_id=project["id"], viewer_user_id=owner["id"]
    )
    # Flip team conversation to visibility=team
    team_conv.visibility = "team"
    sess.add(team_conv)
    sess.commit()
    sess.refresh(team_conv)
    _add_message(team_conv.id, "user", "团队会话首条消息")
    _add_message(team_conv.id, "assistant", "团队会话回复")

    private_conv_a = create_conversation(
        sess, project_id=project["id"], viewer_user_id=member["id"]
    )
    _add_message(private_conv_a.id, "user", "小林的私有会话")

    private_conv_b = create_conversation(
        sess, project_id=project["id"], viewer_user_id=owner["id"]
    )
    _add_message(private_conv_b.id, "user", "负责人的私有会话")

    # Create one team-visible ProjectMemory and one subject_and_owner memory
    # authored with member as subject and owner as owner.
    pm_team = ProjectMemory(
        workspace_id=workspace["id"],
        project_id=project["id"],
        memory_type="plan",
        scope="project",
        content="团队可见的项目计划摘要",
        rationale="经团队讨论确定的阶段计划",
        source_type="direction_card_confirmed",
        source_id="src-team-001",
        status="active",
        visibility="team",
    )
    pm_private = ProjectMemory(
        workspace_id=workspace["id"],
        project_id=project["id"],
        memory_type="member_constraint",
        scope="member",
        content="小林本周仅可投入 8 小时",
        rationale="根据小林反馈记录的可用时间约束",
        source_type="assignment_confirmed",
        source_id="src-private-001",
        status="active",
        visibility="subject_and_owner",
        subject_user_id=member["id"],
        owner_user_id_snapshot=owner["id"],
    )
    sess.add(pm_team)
    sess.add(pm_private)
    sess.commit()
    sess.refresh(pm_team)
    sess.refresh(pm_private)

    # Capture IDs before closing the session — once closed, the ORM objects
    # become detached and attribute access raises DetachedInstanceError.
    result = {
        "owner_id": owner["id"],
        "member_id": member["id"],
        "outsider_id": outsider["id"],
        "workspace_id": workspace["id"],
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "team_conv_id": team_conv.id,
        "private_conv_a_id": private_conv_a.id,
        "private_conv_b_id": private_conv_b.id,
        "team_memory_id": pm_team.id,
        "private_memory_id": pm_private.id,
    }
    sess.close()
    return result


def _seed_run(client: TestClient, ids: dict[str, str]) -> str:
    """Seed an AgentRunV2 with side effects and runtime events.

    Returns the run_id.
    """
    sess = next(app.dependency_overrides[get_session]())

    run = AgentRunV2(
        conversation_id=ids["team_conv_id"],
        project_id=ids["project_id"],
        workspace_id=ids["workspace_id"],
        viewer_user_id=ids["owner_id"],
        status="completed",
        current_turn=1,
        current_step=2,
        model_provider="mock",
        model_name="mock-model",
        resolved_model_provider="mock",
        resolved_model_name="mock-model",
        last_event_seq=2,
    )
    run.set_side_effects([
        {
            "tool_call_id": "call_1",
            "status": "completed",
            "effect_type": "advisory",
            "tool_name": "create_risk",
        }
    ])
    sess.add(run)
    sess.commit()
    sess.refresh(run)

    # Add runtime events with payload containing memory_ids_used and skills
    event_1 = AgentRunEvent(
        run_id=run.id,
        conversation_id=ids["team_conv_id"],
        workspace_id=ids["workspace_id"],
        project_id=ids["project_id"],
        type="run.started",
        event_seq=0,
        client_event_id="ce_1",
        payload=json.dumps({
            "selected_skills": ["project-intake"],
            "used_memory_ids": [ids["team_memory_id"]],
            "hidden_context": "context sentinel",
        }),
    )
    event_2 = AgentRunEvent(
        run_id=run.id,
        conversation_id=ids["team_conv_id"],
        workspace_id=ids["workspace_id"],
        project_id=ids["project_id"],
        type="tool.started",
        event_seq=1,
        client_event_id="ce_2",
        payload=json.dumps({"tool_name": "create_risk"}),
    )
    event_3 = AgentRunEvent(
        run_id=run.id,
        conversation_id=ids["team_conv_id"],
        workspace_id=ids["workspace_id"],
        project_id=ids["project_id"],
        type="run.completed",
        event_seq=2,
        client_event_id="ce_3",
        payload=json.dumps({}),
        # Trace is intentionally populated to verify snapshot does NOT expose it
        trace=json.dumps({"secret_chain_of_thought": "should not leak"}),
    )
    sess.add(event_1)
    sess.add(event_2)
    sess.add(event_3)
    sess.commit()
    run_id = run.id
    sess.close()
    return run_id


# ---------------------------------------------------------------------------
# Authentication tests
# ---------------------------------------------------------------------------


def test_evidence_endpoint_rejects_missing_internal_token(monkeypatch, tmp_path):
    """Without Authorization header, request must fail with 403."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)

    headers = {
        "X-Evaluation-Nonce": NONCE,
        "X-Evaluation-Instance-Id": INSTANCE_ID,
    }
    response = client_app().get(
        "/internal/evaluation/evidence",
        headers=headers,
        params={"workspace_id": "any", "viewer_user_id": "any"},
    )
    assert response.status_code == 403


def test_evidence_endpoint_rejects_non_evaluation_env(monkeypatch, tmp_path):
    """In development env, evidence endpoint must fail-closed with 403."""
    monkeypatch.setattr(app_settings, "app_env", "development")
    # No evaluation env configured — internal token still required
    response = client_app().get(
        "/internal/evaluation/evidence",
        headers={
            "Authorization": f"Bearer {INTERNAL_TOKEN}",
            "X-Evaluation-Nonce": NONCE,
            "X-Evaluation-Instance-Id": INSTANCE_ID,
        },
        params={"workspace_id": "any", "viewer_user_id": "any"},
    )
    assert response.status_code == 403


def test_evidence_endpoint_rejects_wrong_nonce(monkeypatch, tmp_path, client):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(nonce="wrong-nonce"),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 403


def test_evidence_endpoint_rejects_wrong_instance_id(monkeypatch, tmp_path, client):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(instance_id="other-instance"),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 403


def test_evidence_endpoint_rejects_missing_ownership_marker(monkeypatch, tmp_path, client):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    # Intentionally do NOT write the marker
    ids = _seed_fixture(client)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 403


def test_evidence_endpoint_rejects_db_path_outside_temp_root(monkeypatch, tmp_path, client):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    # Override database_url to point outside temp_root
    outside_db = os.path.realpath(os.path.join(temp_root, "..", "outside.sqlite"))
    monkeypatch.setattr(app_settings, "database_url", f"sqlite:///{outside_db}")

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 403


def test_evidence_endpoint_succeeds_with_full_auth(monkeypatch, tmp_path, client):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["schema_version"] == 1
    assert data["workspace_id"] == ids["workspace_id"]
    assert data["viewer_user_id"] == ids["owner_id"]


# ---------------------------------------------------------------------------
# Authorization tests
# ---------------------------------------------------------------------------


def test_evidence_endpoint_rejects_non_workspace_member_viewer(monkeypatch, tmp_path, client):
    """A user who is not a workspace member must get 404 (not 200 with empty data)."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "viewer_user_id": ids["outsider_id"],
        },
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Viewer-scoped filtering tests
# ---------------------------------------------------------------------------


def test_evidence_snapshot_filters_private_conversations_by_viewer(
    monkeypatch, tmp_path, client
):
    """Private conversations must only be visible to their creator."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    # Owner views: sees team conv + own private conv_b; NOT member's private_conv_a
    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 200
    conv_ids = {c["conversation_id"] for c in response.json()["conversation_facts"]}
    assert ids["team_conv_id"] in conv_ids
    assert ids["private_conv_b_id"] in conv_ids
    assert ids["private_conv_a_id"] not in conv_ids

    # Member views: sees team conv + own private conv_a; NOT owner's private_conv_b
    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["member_id"]},
    )
    assert response.status_code == 200
    conv_ids = {c["conversation_id"] for c in response.json()["conversation_facts"]}
    assert ids["team_conv_id"] in conv_ids
    assert ids["private_conv_a_id"] in conv_ids
    assert ids["private_conv_b_id"] not in conv_ids


def test_evidence_snapshot_filters_subject_and_owner_memory_visibility(
    monkeypatch, tmp_path, client
):
    """subject_and_owner memory content must only be visible to subject/owner.

    Non-authorized viewers (other workspace members) see the memory row is
    absent — the snapshot omits invisible memories entirely, matching the
    public memories endpoint behavior. This proves the snapshot cannot leak
    private content.
    """
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    # Owner views: sees both structural memory facts, but the normalized
    # evidence seam never returns raw content or rationale.
    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 200
    mem_by_id = {m["memory_id"]: m for m in response.json()["memory_facts"]}
    assert ids["team_memory_id"] in mem_by_id
    assert ids["private_memory_id"] in mem_by_id
    assert mem_by_id[ids["team_memory_id"]]["content_visible"] is True
    assert mem_by_id[ids["private_memory_id"]]["content_visible"] is True
    assert "content" not in mem_by_id[ids["team_memory_id"]]
    assert "rationale" not in mem_by_id[ids["team_memory_id"]]
    assert "content" not in mem_by_id[ids["private_memory_id"]]
    assert "rationale" not in mem_by_id[ids["private_memory_id"]]

    # Member (subject) sees the private memory structural fact, still without
    # raw private text.
    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["member_id"]},
    )
    assert response.status_code == 200
    mem_by_id = {m["memory_id"]: m for m in response.json()["memory_facts"]}
    assert ids["team_memory_id"] in mem_by_id
    assert ids["private_memory_id"] in mem_by_id
    assert mem_by_id[ids["private_memory_id"]]["content_visible"] is True
    assert "content" not in mem_by_id[ids["private_memory_id"]]


def test_evidence_snapshot_omits_invisible_memory_rather_than_redacting(
    monkeypatch, tmp_path, client
):
    """A memory the viewer cannot see at all is omitted, not redacted in-place.

    This mirrors the public /api/memories endpoint: invisible rows are absent.
    Adding a third member who is neither subject nor owner verifies that the
    private memory is not surfaced to them.
    """
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    # Add a third member to the workspace
    third = client.post("/api/users", json={"display_name": "新成员"}).json()
    client.post(
        f"/api/workspaces/{ids['workspace_id']}/members",
        json={"user_id": third["id"], "role": "member"},
    )

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": third["id"]},
    )
    assert response.status_code == 200
    mem_by_id = {m["memory_id"]: m for m in response.json()["memory_facts"]}
    # Team memory visible to third member
    assert ids["team_memory_id"] in mem_by_id
    assert mem_by_id[ids["team_memory_id"]]["content_visible"] is True
    # Private subject_and_owner memory NOT visible to third member
    assert ids["private_memory_id"] not in mem_by_id


# ---------------------------------------------------------------------------
# Normalization tests
# ---------------------------------------------------------------------------


def test_evidence_snapshot_returns_no_raw_payload_values(
    monkeypatch, tmp_path, client
):
    """Snapshot must not include raw payload strings, snapshot blobs, or trace
    payloads. Only normalized facts (presence flags, keys, structural IDs)."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    run_id = _seed_run(client, ids)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "viewer_user_id": ids["owner_id"],
            "run_id": run_id,
        },
    )
    assert response.status_code == 200, response.text
    body_text = response.text

    # Sensitive content that must NOT appear in the snapshot
    forbidden = [
        "secret_chain_of_thought",  # trace content
        "src-team-001",  # raw source_id (internal)
        "src-private-001",  # raw source_id (internal)
        "should not leak",  # trace payload
    ]
    for token in forbidden:
        assert token not in body_text, f"snapshot leaked forbidden token: {token}"

    # Validate ProposalFacts shape: payload_keys only (no values)
    # (No AgentProposal seeded; ensure field is at least empty list, not blob)
    assert isinstance(response.json()["proposal_facts"], list)


def test_evidence_snapshot_excludes_absolute_paths_and_secrets(
    monkeypatch, tmp_path, client
):
    """Snapshot must not include absolute paths, file URLs, or secrets."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 200
    body_text = response.text
    assert temp_root not in body_text  # No absolute temp_root path
    assert NONCE not in body_text  # No nonce secret
    assert INTERNAL_TOKEN not in body_text  # No internal token
    assert "sqlite:///" not in body_text  # No database URL


# ---------------------------------------------------------------------------
# Read-only enforcement tests
# ---------------------------------------------------------------------------


def test_evidence_snapshot_does_not_mutate_database(
    monkeypatch, tmp_path, client
):
    """Calling the evidence endpoint must not create or modify any rows.

    We compare row counts of every fact-bearing table before and after.
    """
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    run_id = _seed_run(client, ids)

    sess = next(app.dependency_overrides[get_session]())
    from app.models import (
        AgentConversation as _AC,
        AgentMessage as _AM,
        ProjectMemory as _PM,
        Project as _P,
        Stage as _S,
        Task as _T,
    )
    from app.models.agent_run_state import AgentRunEvent as _ARE, AgentRunV2 as _AR

    def counts() -> dict[str, int]:
        from sqlmodel import select
        return {
            "projects": len(sess.exec(select(_P)).all()),
            "stages": len(sess.exec(select(_S)).all()),
            "tasks": len(sess.exec(select(_T)).all()),
            "conversations": len(sess.exec(select(_AC)).all()),
            "messages": len(sess.exec(select(_AM)).all()),
            "memories": len(sess.exec(select(_PM)).all()),
            "runs": len(sess.exec(select(_AR)).all()),
            "run_events": len(sess.exec(select(_ARE)).all()),
        }

    before = counts()
    sess.close()

    # Hit the endpoint multiple times
    for _ in range(3):
        response = client.get(
            "/internal/evaluation/evidence",
            headers=_evaluation_headers(),
            params={
                "workspace_id": ids["workspace_id"],
                "viewer_user_id": ids["owner_id"],
                "run_id": run_id,
            },
        )
        assert response.status_code == 200

    sess = next(app.dependency_overrides[get_session]())
    after = counts()
    sess.close()

    assert before == after, f"snapshot mutated DB: {before} -> {after}"


# ---------------------------------------------------------------------------
# Conditional fact sections (run_id-dependent)
# ---------------------------------------------------------------------------


def test_evidence_snapshot_omits_run_scoped_facts_without_run_id(
    monkeypatch, tmp_path, client
):
    """Without run_id, trajectory/side_effect/metric/context_receipt facts
    must be empty/null."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    _seed_run(client, ids)  # Seed a run but don't query it

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["trajectory_facts"] == []
    assert data["side_effect_facts"] == []
    assert data["metric_facts"] is None
    assert data["context_receipt_facts"] is None
    assert data["run_id"] is None


def test_evidence_snapshot_includes_run_scoped_facts_with_run_id(
    monkeypatch, tmp_path, client
):
    """With run_id, trajectory/side_effect/metric/context_receipt facts
    must be populated with normalized structural facts only."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    run_id = _seed_run(client, ids)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "viewer_user_id": ids["owner_id"],
            "run_id": run_id,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["run_id"] == run_id

    # Trajectory facts: normalized type/seq/tool only, no payload content
    traj = data["trajectory_facts"]
    assert len(traj) == 3
    types = {t["event_type"] for t in traj}
    assert types == {"run.started", "tool.started", "run.completed"}
    for t in traj:
        assert set(t.keys()) == {
            "event_type", "event_seq", "tool_name", "created_at"
        }
    assert next(t for t in traj if t["event_type"] == "tool.started")[
        "tool_name"
    ] == "create_risk"

    # Side effect facts: only structural fields
    se = data["side_effect_facts"]
    assert len(se) == 1
    assert se[0]["tool_call_id"] == "call_1"
    assert se[0]["tool_name"] == "create_risk"
    assert se[0]["effect_type"] == "advisory"
    assert set(se[0].keys()) == {"tool_call_id", "status", "effect_type", "tool_name"}

    # Metric facts: only structural fields
    mf = data["metric_facts"]
    assert mf is not None
    assert mf["run_id"] == run_id
    assert mf["run_status"] == "completed"
    assert mf["model_provider"] == "mock"
    assert mf["resolved_model_name"] == "mock-model"
    assert mf["side_effects_count"] == 1
    assert mf["last_event_seq"] == 2

    # Context receipt: only structural IDs, no content
    cr = data["context_receipt_facts"]
    assert cr is not None
    assert ids["team_memory_id"] in cr["memory_ids_used"]
    assert "project-intake" in cr["skill_names"]
    assert "create_risk" in cr["tool_manifest_names"]
    assert set(cr.keys()) == {"memory_ids_used", "skill_names", "tool_manifest_names"}


def test_hidden_field_probes_cover_request_context_and_trace_without_echoing_tokens(
    monkeypatch, tmp_path, client
):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    run_id = _seed_run(client, ids)
    tokens = ["团队会话首条消息", "context sentinel", "should not leak"]
    params = [
        ("workspace_id", ids["workspace_id"]),
        ("viewer_user_id", ids["owner_id"]),
        ("run_id", run_id),
        *[
            (
                "hidden_token_probe",
                f"{len(token)}:{hashlib.sha256(token.encode()).hexdigest()}",
            )
            for token in tokens
        ],
    ]
    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params=params,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["hidden_field_probe_facts"] == {
        "request_body_match": True,
        "context_receipt_match": True,
        "trace_match": True,
    }
    serialized = response.text
    assert all(token not in serialized for token in tokens)


def test_hidden_field_probe_rejects_malformed_commitment(
    monkeypatch, tmp_path, client
):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "viewer_user_id": ids["owner_id"],
            "hidden_token_probe": "raw-secret",
        },
    )
    assert response.status_code == 400


def test_evidence_snapshot_with_unknown_run_id_fails_closed(
    monkeypatch, tmp_path, client
):
    """An explicit unknown run ID must not degrade to unscoped state evidence."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "viewer_user_id": ids["owner_id"],
            "run_id": "nonexistent-run-id",
        },
    )
    assert response.status_code == 404


def test_evidence_snapshot_rejects_run_from_another_viewer(
    monkeypatch, tmp_path, client
):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    run_id = _seed_run(client, ids)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "project_id": ids["project_id"],
            "viewer_user_id": ids["member_id"],
            "run_id": run_id,
        },
    )
    assert response.status_code == 404


def test_evidence_snapshot_rejects_run_from_another_project(
    monkeypatch, tmp_path, client
):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    run_id = _seed_run(client, ids)
    other_project = client.post(
        "/api/projects",
        json={
            "workspace_id": ids["workspace_id"],
            "name": "另一个项目",
            "idea": "用于验证运行证据隔离",
            "deadline": "2026-08-30",
            "deliverables": "隔离验证",
            "created_by": ids["owner_id"],
        },
    ).json()

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "project_id": other_project["id"],
            "viewer_user_id": ids["owner_id"],
            "run_id": run_id,
        },
    )
    assert response.status_code == 404


def test_evidence_snapshot_rejects_mismatched_conversation_and_run(
    monkeypatch, tmp_path, client
):
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)
    run_id = _seed_run(client, ids)
    other_conversation = client.post(
        f"/api/projects/{ids['project_id']}/agent-conversations",
        json={"viewer_user_id": ids["owner_id"]},
    ).json()

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "project_id": ids["project_id"],
            "viewer_user_id": ids["owner_id"],
            "conversation_id": other_conversation["id"],
            "run_id": run_id,
        },
    )
    assert response.status_code == 404


def test_evidence_snapshot_context_receipt_parses_nested_memory_field(
    monkeypatch, tmp_path, client
):
    """T46-2 adversarial review finding M-04: AgentEvent output_snapshot
    records `_memory.used_memory_ids` per AGENTS.md, but the original
    implementation only scanned flat top-level keys (`memory_ids`,
    `memory_ids_used`, `used_memory_ids`). The nested `_memory` sub-object
    must also be scanned so production runtime events (which use the
    nested form) populate `context_receipt_facts.memory_ids_used`.
    """
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    # Seed a run whose runtime event payload uses the nested `_memory` form
    # documented in AGENTS.md (output_snapshot._memory.used_memory_ids).
    sess = next(app.dependency_overrides[get_session]())
    run = AgentRunV2(
        conversation_id=ids["team_conv_id"],
        project_id=ids["project_id"],
        workspace_id=ids["workspace_id"],
        viewer_user_id=ids["owner_id"],
        status="completed",
        current_turn=1,
        current_step=1,
        model_provider="mock",
        model_name="mock-model",
        resolved_model_provider="mock",
        resolved_model_name="mock-model",
        last_event_seq=0,
    )
    run.set_side_effects([])
    sess.add(run)
    sess.commit()
    sess.refresh(run)

    nested_memory_event = AgentRunEvent(
        run_id=run.id,
        conversation_id=ids["team_conv_id"],
        workspace_id=ids["workspace_id"],
        project_id=ids["project_id"],
        type="agent.completed",
        event_seq=0,
        client_event_id="ce_nested",
        payload=json.dumps({
            "_memory": {
                "used": True,
                "backend": "fts5",
                "used_memory_ids": [ids["team_memory_id"]],
            },
        }),
    )
    sess.add(nested_memory_event)
    sess.commit()
    run_id = run.id
    sess.close()

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={
            "workspace_id": ids["workspace_id"],
            "viewer_user_id": ids["owner_id"],
            "run_id": run_id,
        },
    )
    assert response.status_code == 200, response.text
    cr = response.json()["context_receipt_facts"]
    assert cr is not None, "context_receipt_facts must be present when run_id has events"
    # The memory ID nested under `_memory.used_memory_ids` must appear in
    # the parsed `memory_ids_used` list. The original implementation missed
    # this nested form and only scanned flat top-level keys.
    assert ids["team_memory_id"] in cr["memory_ids_used"], (
        f"nested _memory.used_memory_ids not parsed; got {cr['memory_ids_used']}"
    )


def test_evidence_snapshot_returns_normalized_state_facts(
    monkeypatch, tmp_path, client
):
    """State facts must include stages, tasks, members, assignment_proposals
    as normalized facts with stable field set."""
    temp_root = os.path.realpath(str(tmp_path))
    _configure_evaluation_env(monkeypatch, temp_root)
    _write_marker(temp_root)
    ids = _seed_fixture(client)

    response = client.get(
        "/internal/evaluation/evidence",
        headers=_evaluation_headers(),
        params={"workspace_id": ids["workspace_id"], "viewer_user_id": ids["owner_id"]},
    )
    assert response.status_code == 200
    state = response.json()["state_facts"]
    assert state["workspace_id"] == ids["workspace_id"]
    assert state["project_id"] == ids["project_id"]
    assert state["project_name"] == "证据快照项目"
    assert state["stage_count"] == 1
    assert state["task_count"] == 1
    assert state["member_count"] == 2
    assert len(state["stages"]) == 1
    assert state["stages"][0]["stage_id"] == ids["stage_id"]
    assert state["stages"][0]["name"] == "开发阶段"
    assert len(state["tasks"]) == 1
    assert state["tasks"][0]["task_id"] == ids["task_id"]
    assert state["tasks"][0]["title"] == "后端 API 与数据模型"
    assert state["tasks"][0]["priority"] == "P0"
    member_ids = {m["user_id"] for m in state["members"]}
    assert {ids["owner_id"], ids["member_id"]}.issubset(member_ids)
    # Display names should be present (no raw IDs in display fields)
    member_names = {m["display_name"] for m in state["members"]}
    assert "项目负责人" in member_names
    assert "小林" in member_names


# ---------------------------------------------------------------------------
# Helpers used by the no-client auth tests
# ---------------------------------------------------------------------------


def client_app():
    """Return the module-level app TestClient without the in-memory override.

    Used by tests that assert 403 before any data is needed.
    """
    from app.main import app as _app
    return TestClient(_app)
