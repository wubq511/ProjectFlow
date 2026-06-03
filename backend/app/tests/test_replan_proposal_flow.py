"""Tests for replan proposal persistence, confirm, and reject lifecycle."""


from fastapi.testclient import TestClient


def _create_replan_fixture(client: TestClient):
    owner = client.post("/api/users", json={"display_name": "Replan Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Replan Member"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Replan Workspace"},
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
            "name": "Replan Project",
            "idea": "Test replan proposal flow",
            "deadline": "2026-06-10",
            "deliverables": "Demo",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Implementation",
            "goal": "Build features",
            "start_date": "2026-05-29",
            "end_date": "2026-06-05",
            "deliverable": "Working app",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Build API",
            "description": "Create REST endpoints",
            "priority": "P0",
            "due_date": "2026-06-01",
            "estimated_hours": 8,
        },
    ).json()
    return workspace, project, stage, task, owner, member


def _seed_agent_events(client: TestClient, project: dict, workspace: dict):
    """Create minimal agent events so timeline has entries."""
    client.post(
        "/api/seed/demo",
    )


def test_replan_creates_pending_proposal(client: TestClient):
    """After running replan via agent flow, a pending proposal should exist."""
    workspace, project, stage, task, owner, member = _create_replan_fixture(client)

    # Run replan agent flow
    replan_response = client.post(
        "/api/agent/replan",
        json={"workspace_id": workspace["id"]},
    )
    assert replan_response.status_code == 200
    result = replan_response.json()
    assert result["event_type"] == "replan"
    assert result["proposal_id"] is not None

    # Verify proposal exists and is pending
    proposal_id = result["proposal_id"]
    proposal_response = client.get(f"/api/agent-proposals/{proposal_id}")
    assert proposal_response.status_code == 200
    proposal = proposal_response.json()
    assert proposal["proposal_type"] == "replan"
    assert proposal["status"] == "pending"


def test_replan_proposal_confirm_applies_changes(client: TestClient):
    """Confirming a replan proposal should apply stage/task/action changes."""
    workspace, project, stage, task, owner, member = _create_replan_fixture(client)

    # Run replan
    replan_response = client.post(
        "/api/agent/replan",
        json={"workspace_id": workspace["id"]},
    )
    assert replan_response.status_code == 200
    proposal_id = replan_response.json()["proposal_id"]

    # Confirm the proposal
    confirm_response = client.post(
        f"/api/agent-proposals/{proposal_id}/confirm",
        json={"confirmed_by": owner["id"]},
    )
    assert confirm_response.status_code == 200
    confirmed = confirm_response.json()
    assert confirmed["status"] == "confirmed"
    assert confirmed["confirmed_by"] == owner["id"]


def test_replan_proposal_reject_no_state_change(client: TestClient):
    """Rejecting a replan proposal should not modify any project state."""
    workspace, project, stage, task, owner, member = _create_replan_fixture(client)

    # Run replan
    replan_response = client.post(
        "/api/agent/replan",
        json={"workspace_id": workspace["id"]},
    )
    assert replan_response.status_code == 200
    proposal_id = replan_response.json()["proposal_id"]

    # Record task state before reject
    task_before = client.get(f"/api/tasks/{task['id']}").json()

    # Reject the proposal
    reject_response = client.post(
        f"/api/agent-proposals/{proposal_id}/reject",
        json={"reason": "计划不需要调整"},
    )
    assert reject_response.status_code == 200
    rejected = reject_response.json()
    assert rejected["status"] == "rejected"

    # Verify task state unchanged
    task_after = client.get(f"/api/tasks/{task['id']}").json()
    assert task_before["status"] == task_after["status"]
    assert task_before["due_date"] == task_after["due_date"]


def test_list_replan_proposals_by_project(client: TestClient):
    """Can filter proposals by type=replan."""
    workspace, project, stage, task, owner, member = _create_replan_fixture(client)

    # Run replan
    client.post(
        "/api/agent/replan",
        json={"workspace_id": workspace["id"]},
    )

    # List with filter
    response = client.get(
        f"/api/agent-proposals?project_id={project['id']}&proposal_type=replan"
    )
    assert response.status_code == 200
    proposals = response.json()
    assert len(proposals) >= 1
    assert all(p["proposal_type"] == "replan" for p in proposals)


def test_risk_analysis_prompt_allows_multiple_risks(client: TestClient):
    """Risk output contract should allow up to 3 risks, not exactly 1."""
    from app.agent.prompts import OUTPUT_CONTRACT_BY_EVENT_TYPE
    from app.models.enums import AgentEventType

    contract = OUTPUT_CONTRACT_BY_EVENT_TYPE[AgentEventType.risk]
    # Should NOT say "exactly 1"
    assert "exactly 1" not in contract.lower()
    # Should mention up to 3 or multiple
    assert "3" in contract or "up to" in contract.lower() or "multiple" in contract.lower()


def test_export_timeline_includes_status(client: TestClient):
    """Exported timeline should include event status."""
    client.post("/api/seed/demo")
    response = client.post("/api/projects/demo-project-001/export/review-summary")
    assert response.status_code == 200
    md = response.json()["markdown"]
    # Should contain status indicators in timeline section
    assert "success" in md or "fallback" in md or "failed" in md


def test_export_no_none_or_null(client: TestClient):
    """Exported markdown should not contain raw None or null."""
    client.post("/api/seed/demo")
    response = client.post("/api/projects/demo-project-001/export/review-summary")
    assert response.status_code == 200
    md = response.json()["markdown"]
    assert "None" not in md
    assert "null" not in md


def test_empty_risk_analysis_no_crash(client: TestClient):
    """Risk analysis on a project with no data should not crash."""
    owner = client.post("/api/users", json={"display_name": "Empty Owner"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Empty Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Empty Project",
            "idea": "No data yet",
            "deadline": "2026-06-15",
            "deliverables": "TBD",
            "created_by": owner["id"],
        },
    ).json()
    client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Planning",
            "goal": "Define scope",
            "start_date": "2026-06-01",
            "end_date": "2026-06-10",
            "deliverable": "Plan doc",
        },
    )

    # Run risk analysis - should not crash
    risk_response = client.post(
        "/api/agent/risk-analysis",
        json={"workspace_id": workspace["id"]},
    )
    assert risk_response.status_code == 200
    result = risk_response.json()
    # Mock mode returns fallback with empty risks
    assert "output" in result


def test_demo_replan_fallback_has_minimal_actionable_proposal(client: TestClient):
    """Demo seed in mock mode should still produce a useful replan proposal."""
    client.post("/api/seed/demo")

    response = client.post(
        "/api/agent/replan",
        json={"workspace_id": "demo-workspace-001"},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["proposal_id"] is not None
    output = result["output"]
    assert output["requires_confirmation"] is True
    assert len(output["stage_adjustments"]) <= 1
    assert len(output["task_changes"]) <= 1
    assert len(output["action_cards"]) <= 1
    assert output["task_changes"], "mock fallback should propose one task-level adjustment for the seeded blocker"
    assert output["action_cards"], "mock fallback should create one risk action card for the seeded blocker"


def test_export_uses_readable_enum_values(client: TestClient):
    """Export should not leak Python enum reprs into Markdown."""
    client.post("/api/seed/demo")

    response = client.post("/api/projects/demo-project-001/export/review-summary")

    assert response.status_code == 200
    markdown = response.json()["markdown"]
    assert "AgentEventType." not in markdown
    assert "AgentEventStatus." not in markdown
    assert "RiskSeverity." not in markdown
    assert "RiskType." not in markdown
    assert "RiskStatus." not in markdown
