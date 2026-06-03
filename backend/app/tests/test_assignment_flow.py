from fastapi.testclient import TestClient


def _create_assignment_fixture(client: TestClient):
    owner = client.post("/api/users", json={"display_name": "Assignment Owner"}).json()
    member = client.post("/api/users", json={"display_name": "Assignment Member"}).json()
    backup = client.post("/api/users", json={"display_name": "Assignment Backup"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Assignment Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": member["id"], "role": "member"},
    )
    client.post(
        f"/api/workspaces/{workspace['id']}/members",
        json={"user_id": backup["id"], "role": "member"},
    )
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Assignment Project",
            "idea": "Coordinate task ownership",
            "deadline": "2026-06-07",
            "deliverables": "Backend flow",
            "created_by": owner["id"],
        },
    ).json()
    stage = client.post(
        "/api/stages",
        json={
            "project_id": project["id"],
            "name": "Execution",
            "goal": "Ship assignment flow",
            "start_date": "2026-05-29",
            "end_date": "2026-06-02",
            "deliverable": "Working assignment API",
        },
    ).json()
    task = client.post(
        "/api/tasks",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "title": "Build assignment flow",
            "description": "Proposal, response, negotiation, and finalize",
            "priority": "P0",
            "due_date": "2026-05-31",
            "estimated_hours": 4,
        },
    ).json()
    return project, stage, task, member, backup


def test_assignment_proposal_response_negotiation_and_finalize_updates_owner_after_confirmation(client: TestClient):
    project, stage, task, member, backup = _create_assignment_fixture(client)

    proposal_response = client.post(
        "/api/assignment-proposals",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "task_id": task["id"],
            "recommended_owner_user_id": member["id"],
            "backup_owner_user_id": backup["id"],
            "reason": "Member has the strongest backend fit.",
            "risk_note": "Backup keeps the work covered.",
            "created_by_agent": True,
        },
    )
    assert proposal_response.status_code == 201
    proposal = proposal_response.json()
    assert proposal["status"] == "proposed"

    task_before_confirmation = client.get(f"/api/tasks/{task['id']}").json()
    assert task_before_confirmation["owner_user_id"] is None

    unauthorized_response = client.post(
        f"/api/assignment-proposals/{proposal['id']}/responses",
        json={
            "user_id": backup["id"],
            "response": "accept",
            "reason": "I am not the recommended owner.",
        },
    )
    assert unauthorized_response.status_code == 400

    response = client.post(
        f"/api/assignment-proposals/{proposal['id']}/responses",
        json={
            "user_id": member["id"],
            "response": "accept",
            "reason": "I can take this.",
        },
    )
    assert response.status_code == 201
    assert response.json()["response"] == "accept"

    proposal_after_response = client.get(f"/api/assignment-proposals/{proposal['id']}").json()
    assert proposal_after_response["status"] == "owner_confirmed"

    task_after_response = client.get(f"/api/tasks/{task['id']}").json()
    assert task_after_response["owner_user_id"] is None

    finalized = client.post(f"/api/assignment-proposals/{proposal['id']}/finalize")
    assert finalized.status_code == 200
    assert finalized.json()["status"] == "finalized"

    task_after_finalize = client.get(f"/api/tasks/{task['id']}").json()
    assert task_after_finalize["owner_user_id"] == member["id"]
    assert task_after_finalize["backup_owner_user_id"] == backup["id"]
    assert task_after_finalize["assignment_reason"] == "Member has the strongest backend fit."

    negotiation = client.post(
        "/api/assignment-negotiations",
        json={
            "project_id": project["id"],
            "stage_id": stage["id"],
            "from_user_id": backup["id"],
            "desired_task_id": task["id"],
            "current_owner_user_id": member["id"],
            "agent_message": "Ask the confirmed owner before swapping.",
        },
    )
    assert negotiation.status_code == 201
    assert negotiation.json()["status"] == "pending"


# ---------------------------------------------------------------------------
# T23.B Assignment state defense tests
# ---------------------------------------------------------------------------


def test_cannot_create_duplicate_active_proposal_for_same_task(client: TestClient):
    """Creating a second active proposal for the same task is rejected."""
    project, stage, task, member, backup = _create_assignment_fixture(client)

    payload = {
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "recommended_owner_user_id": member["id"],
        "backup_owner_user_id": backup["id"],
        "reason": "First proposal.",
        "created_by_agent": True,
    }

    first = client.post("/api/assignment-proposals", json=payload)
    assert first.status_code == 201

    second = client.post("/api/assignment-proposals", json=payload)
    assert second.status_code == 400
    detail = second.json().get("detail", "")
    assert "already" in detail.lower()


def test_can_recommend_same_task_to_different_owner_after_rejection(client: TestClient):
    """After rejection, a different owner can be recommended for the same task."""
    project, stage, task, member, backup = _create_assignment_fixture(client)

    # Create proposal
    proposal = client.post("/api/assignment-proposals", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "recommended_owner_user_id": member["id"],
        "backup_owner_user_id": None,
        "reason": "Test proposal.",
        "created_by_agent": True,
    }).json()

    # Reject it
    client.post(f"/api/assignment-proposals/{proposal['id']}/responses", json={
        "user_id": member["id"],
        "response": "reject",
        "reason": "Too busy.",
    })

    # Same owner recommended again should fail
    same_owner = client.post("/api/assignment-proposals", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "recommended_owner_user_id": member["id"],
        "reason": "Should fail.",
        "created_by_agent": True,
    })
    assert same_owner.status_code == 400

    # Different owner (backup) should succeed
    other_owner = client.post("/api/assignment-proposals", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "recommended_owner_user_id": backup["id"],
        "reason": "New owner after rejection.",
        "created_by_agent": True,
    })
    assert other_owner.status_code == 201


def test_cannot_respond_to_finalized_or_rejected_proposal(client: TestClient):
    """Only proposed proposals can be responded to."""
    project, stage, task, member, backup = _create_assignment_fixture(client)

    proposal = client.post("/api/assignment-proposals", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "recommended_owner_user_id": member["id"],
        "backup_owner_user_id": backup["id"],
        "reason": "Test proposal.",
        "created_by_agent": True,
    }).json()

    # Accept then finalize
    client.post(f"/api/assignment-proposals/{proposal['id']}/responses", json={
        "user_id": member["id"],
        "response": "accept",
    })
    client.post(f"/api/assignment-proposals/{proposal['id']}/finalize")

    # Try to respond again after finalized
    bad_response = client.post(f"/api/assignment-proposals/{proposal['id']}/responses", json={
        "user_id": member["id"],
        "response": "reject",
        "reason": "Should not be allowed.",
    })
    assert bad_response.status_code == 400


def test_reject_requires_reason(client: TestClient):
    """Reject response without a reason is rejected."""
    project, stage, task, member, _ = _create_assignment_fixture(client)

    proposal = client.post("/api/assignment-proposals", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "recommended_owner_user_id": member["id"],
        "reason": "Test proposal.",
        "created_by_agent": True,
    }).json()

    # Omitting reason triggers 422 via Pydantic because NonEmptyStr requires a value.
    # This validates that the service catches missing reasons before processing.
    response = client.post(f"/api/assignment-proposals/{proposal['id']}/responses", json={
        "user_id": member["id"],
        "response": "reject",
    })
    assert response.status_code in (400, 422)


def test_proposal_task_stage_project_must_match(client: TestClient):
    """Proposal relationships between task, stage, and project are enforced."""
    project, stage, task, member, _ = _create_assignment_fixture(client)

    # Mismatched stage for this task
    bad_stage = client.post("/api/assignment-proposals", json={
        "project_id": project["id"],
        "stage_id": "nonexistent-stage",
        "task_id": task["id"],
        "recommended_owner_user_id": member["id"],
        "reason": "Wrong stage.",
        "created_by_agent": True,
    })
    assert bad_stage.status_code == 400  # require_row raises ValueError -> 400


def test_negotiation_from_proposal_generates_readable_message(client: TestClient):
    """B5: Negotiation agent_message uses display names and task titles, not raw IDs."""
    project, stage, task, member, backup = _create_assignment_fixture(client)

    # Create a proposal and reject it with a preferred task
    # First, create another task in the same project for the preferred task
    second_task = client.post("/api/tasks", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "title": "Second task for preference",
        "description": "Task for testing negotiation message content",
        "priority": "P1",
        "due_date": "2026-06-05",
        "estimated_hours": 3,
    }).json()

    proposal = client.post("/api/assignment-proposals", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "recommended_owner_user_id": member["id"],
        "backup_owner_user_id": backup["id"],
        "reason": "Member has the strongest fit.",
        "created_by_agent": True,
    }).json()

    # Reject with preferred task
    client.post(f"/api/assignment-proposals/{proposal['id']}/responses", json={
        "user_id": member["id"],
        "response": "reject",
        "preferred_task_id": second_task["id"],
        "reason": "I prefer the second task.",
    })

    # Create negotiation from proposal
    negotiation = client.post(
        f"/api/assignment-proposals/{proposal['id']}/negotiations",
        json={
            "from_user_id": member["id"],
            "desired_task_id": second_task["id"],
        },
    )
    assert negotiation.status_code == 201
    data = negotiation.json()

    # agent_message should contain display name and titles, not UUIDs
    msg = data["agent_message"]
    assert "Assignment Member" in msg  # display name
    assert "Second task for preference" in msg  # task title
    assert "Build assignment flow" in msg  # proposal task title
    assert "not assigned" in msg or "未分配" in msg or "未分配" in msg
    # Should NOT contain raw UUIDs
    assert member["id"] not in msg or msg.count(member["id"]) == 0
    # current_owner_user_id should be the desired task's owner (None since unassigned)
    assert data["current_owner_user_id"] is None
    assert data["status"] == "pending"


def test_negotiation_current_owner_reflects_desired_task_owner(client: TestClient):
    """B5: When desired task has an owner, current_owner_user_id reflects it."""
    project, stage, task, member, backup = _create_assignment_fixture(client)

    # Create a second task and assign an owner to it
    second_task = client.post("/api/tasks", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "title": "Owned task",
        "description": "This task already has an owner",
        "priority": "P1",
        "due_date": "2026-06-05",
        "estimated_hours": 3,
    }).json()

    # Directly assign the task to backup user (no proposal, directly set owner)
    client.patch(f"/api/tasks/{second_task['id']}", json={
        "owner_user_id": backup["id"],
    })

    proposal = client.post("/api/assignment-proposals", json={
        "project_id": project["id"],
        "stage_id": stage["id"],
        "task_id": task["id"],
        "recommended_owner_user_id": member["id"],
        "reason": "Test proposal.",
        "created_by_agent": True,
    }).json()

    # Reject with preferred (owned) task
    client.post(f"/api/assignment-proposals/{proposal['id']}/responses", json={
        "user_id": member["id"],
        "response": "reject",
        "preferred_task_id": second_task["id"],
        "reason": "I want the owned task.",
    })

    negotiation = client.post(
        f"/api/assignment-proposals/{proposal['id']}/negotiations",
        json={
            "from_user_id": member["id"],
            "desired_task_id": second_task["id"],
        },
    )
    assert negotiation.status_code == 201
    data = negotiation.json()

    # current_owner_user_id should be the owner of the desired task
    assert data["current_owner_user_id"] == backup["id"]
