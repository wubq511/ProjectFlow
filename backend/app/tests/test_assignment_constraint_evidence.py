"""Assignment constraint-evidence gate tests.

Covers:
- Missing evidence blocks persistence when member has constraints
- Supplied evidence permits otherwise valid persistence
- Rollback/no partial rows on evidence failure
- Unconstrained members remain compatible (no false positives)
"""

from fastapi.testclient import TestClient


def _create_evidence_fixture(client: TestClient):
    """Create workspace with one constrained member and one unconstrained member."""
    owner = client.post("/api/users", json={"display_name": "Evidence Owner"}).json()
    constrained = client.post("/api/users", json={"display_name": "Constrained Member"}).json()
    unconstrained = client.post("/api/users", json={"display_name": "Free Member"}).json()
    backup = client.post("/api/users", json={"display_name": "Backup Member"}).json()

    workspace = client.post(
        "/api/workspaces",
        json={"name": "Evidence Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()

    for uid in [constrained["id"], unconstrained["id"], backup["id"]]:
        client.post(
            f"/api/workspaces/{workspace['id']}/members",
            json={"user_id": uid, "role": "member"},
        )

    # Create member profile with constraints for constrained member
    client.post(
        "/api/member-profiles",
        json={
            "user_id": constrained["id"],
            "workspace_id": workspace["id"],
            "skills": [],
            "available_hours_per_week": 10,
            "constraints": "不能使用外部API，只能做前端工作",
        },
    )

    # Create member profile WITHOUT constraints for unconstrained member
    client.post(
        "/api/member-profiles",
        json={
            "user_id": unconstrained["id"],
            "workspace_id": workspace["id"],
            "skills": [],
            "available_hours_per_week": 20,
            "constraints": "",
        },
    )

    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Evidence Project",
            "idea": "Test constraint evidence",
            "deadline": "2026-07-20",
            "deliverables": "Working evidence gate",
            "created_by": owner["id"],
        },
    ).json()

    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Execution",
            "goal": "Test evidence",
            "start_date": "2026-07-01",
            "end_date": "2026-07-15",
            "deliverable": "Evidence tests pass",
        },
    ).json()

    task1 = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Frontend task",
            "description": "Build UI components",
            "priority": "P0",
            "due_date": "2026-07-10",
            "estimated_hours": 8,
        },
    ).json()

    task2 = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Backend task",
            "description": "Build API",
            "priority": "P1",
            "due_date": "2026-07-12",
            "estimated_hours": 6,
        },
    ).json()

    return project, stage, task1, task2, constrained, unconstrained, backup


def test_missing_evidence_blocks_when_constrained_member_is_recommended(client: TestClient):
    """Constrained recommended owner + no constraint_respected → 400."""
    project, stage, task1, _, constrained, _, _ = _create_evidence_fixture(client)

    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task1["id"],
            "recommended_owner_user_id": constrained["id"],
            "reason": "Best fit for frontend",
            # constraint_respected is MISSING
            "created_by_agent": True,
        },
    )
    assert response.status_code == 400
    detail = response.json().get("detail", "")
    assert "约束" in detail or "constraint" in detail.lower()


def test_missing_evidence_blocks_when_constrained_member_is_backup(client: TestClient):
    """Constrained backup owner + no constraint_respected → 400."""
    project, stage, task1, _, constrained, unconstrained, _ = _create_evidence_fixture(client)

    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task1["id"],
            "recommended_owner_user_id": unconstrained["id"],
            "backup_owner_user_id": constrained["id"],
            "reason": "Free member leads, constrained backup",
            # constraint_respected is MISSING
            "created_by_agent": True,
        },
    )
    assert response.status_code == 400


def test_empty_string_evidence_blocked_by_schema_validation(client: TestClient):
    """Empty string constraint_respected → 422 (Pydantic NonEmptyStr rejects before service)."""
    project, stage, task1, _, constrained, _, _ = _create_evidence_fixture(client)

    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task1["id"],
            "recommended_owner_user_id": constrained["id"],
            "reason": "Best fit",
            "constraint_respected": "",
            "created_by_agent": True,
        },
    )
    # NonEmptyStr schema validation rejects empty strings before service runs
    assert response.status_code == 422


def test_whitespace_only_evidence_blocked_by_schema_validation(client: TestClient):
    """Whitespace-only constraint_respected → 422 (Pydantic NonEmptyStr rejects)."""
    project, stage, task1, _, constrained, _, _ = _create_evidence_fixture(client)

    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task1["id"],
            "recommended_owner_user_id": constrained["id"],
            "reason": "Best fit",
            "constraint_respected": "   ",
            "created_by_agent": True,
        },
    )
    # NonEmptyStr schema validation rejects whitespace-only strings
    assert response.status_code == 422


def test_supplied_evidence_permits_constrained_member(client: TestClient):
    """Constrained member + non-empty constraint_respected → 201."""
    project, stage, task1, _, constrained, _, _ = _create_evidence_fixture(client)

    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task1["id"],
            "recommended_owner_user_id": constrained["id"],
            "reason": "Best fit for frontend work",
            "constraint_respected": "已确认该成员不能使用外部API，分配前端UI任务",
            "created_by_agent": True,
        },
    )
    assert response.status_code == 201
    proposal = response.json()
    assert proposal["constraint_respected"] == "已确认该成员不能使用外部API，分配前端UI任务"


def test_unconstrained_member_needs_no_evidence(client: TestClient):
    """Unconstrained member + no constraint_respected → 201."""
    project, stage, _, task2, _, unconstrained, _ = _create_evidence_fixture(client)

    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task2["id"],
            "recommended_owner_user_id": unconstrained["id"],
            "reason": "Free member for backend",
            # No constraint_respected needed — member has no constraints
            "created_by_agent": True,
        },
    )
    assert response.status_code == 201


def test_unconstrained_member_without_evidence_still_works(client: TestClient):
    """Unconstrained member + no constraint_respected field → 201 (no false positive)."""
    project, stage, _, task2, _, unconstrained, _ = _create_evidence_fixture(client)

    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task2["id"],
            "recommended_owner_user_id": unconstrained["id"],
            "reason": "Free member for backend",
            # No constraint_respected needed — member has no constraints
            "created_by_agent": True,
        },
    )
    assert response.status_code == 201


def test_no_partial_rows_on_evidence_failure(client: TestClient):
    """When evidence validation fails, no proposal row is created."""
    project, stage, task1, _, constrained, _, _ = _create_evidence_fixture(client)

    # This should fail
    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task1["id"],
            "recommended_owner_user_id": constrained["id"],
            "reason": "Best fit",
            "created_by_agent": True,
        },
    )
    assert response.status_code == 400

    # Verify no proposals exist for this task
    proposals_response = client.get(
        f"/api/projects/{project['id']}/assignment-proposals",
    )
    assert proposals_response.status_code == 200
    task_proposals = [
        p for p in proposals_response.json()
        if p["task_id"] == task1["id"]
    ]
    assert len(task_proposals) == 0


def test_no_member_profile_means_no_constraint_gate(client: TestClient):
    """Member without a profile → no constraint evidence required."""
    owner = client.post("/api/users", json={"display_name": "No Profile Owner"}).json()
    member = client.post("/api/users", json={"display_name": "No Profile Member"}).json()

    workspace = client.post(
        "/api/workspaces",
        json={"name": "No Profile Workspace"},
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
            "name": "No Profile Project",
            "idea": "Test no profile",
            "deadline": "2026-07-20",
            "deliverables": "Test",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "S1",
            "goal": "Test",
            "start_date": "2026-07-01",
            "end_date": "2026-07-15",
            "deliverable": "Test",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Task",
            "description": "Desc",
            "priority": "P0",
            "due_date": "2026-07-10",
            "estimated_hours": 4,
        },
    ).json()

    # No profile created for member — should still work without evidence
    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task["id"],
            "recommended_owner_user_id": member["id"],
            "reason": "No profile member",
            "created_by_agent": True,
        },
    )
    assert response.status_code == 201


def test_evidence_gate_works_in_transaction_with_auto_commit_false(client: TestClient):
    """When using auto_commit=False, evidence failure still rolls back cleanly.

    This is tested indirectly: the service function raises ValueError before
    session.add(proposal), so no partial state is created.
    """
    project, stage, task1, _, constrained, _, _ = _create_evidence_fixture(client)

    # Attempt without evidence — should fail
    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task1["id"],
            "recommended_owner_user_id": constrained["id"],
            "reason": "Should fail",
            "created_by_agent": True,
        },
    )
    assert response.status_code == 400

    # Now try with evidence — should succeed
    response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task1["id"],
            "recommended_owner_user_id": constrained["id"],
            "reason": "Should succeed with evidence",
            "constraint_respected": "成员限制为前端工作，已分配前端UI任务",
            "created_by_agent": True,
        },
    )
    assert response.status_code == 201
