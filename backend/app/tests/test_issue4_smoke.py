"""Smoke tests for Issue #4: Core Workspace and Project APIs."""
from fastapi.testclient import TestClient

from app.main import app
from app.api.routes_users import router as users_router
from app.api.routes_workspaces import router as workspaces_router
from app.api.routes_invitations import router as invitations_router
from app.api.routes_member_profiles import router as profiles_router

app.include_router(users_router, prefix="/api")
app.include_router(workspaces_router, prefix="/api")
app.include_router(invitations_router, prefix="/api")
app.include_router(profiles_router, prefix="/api")


def test_user_crud(client: TestClient):
    # Create
    r = client.post("/api/users", json={"display_name": "Alice", "email": "alice@test.com"})
    assert r.status_code == 201
    user = r.json()
    user_id = user["id"]
    assert user["display_name"] == "Alice"

    # Get
    r = client.get(f"/api/users/{user_id}")
    assert r.status_code == 200
    assert r.json()["email"] == "alice@test.com"

    # List
    r = client.get("/api/users")
    assert r.status_code == 200
    assert len(r.json()) >= 1

    # 404
    r = client.get("/api/users/nonexistent")
    assert r.status_code == 404


def test_workspace_crud(client: TestClient):
    # Create a user first
    r = client.post("/api/users", json={"display_name": "Owner"})
    owner_id = r.json()["id"]

    # Create workspace
    r = client.post(
        "/api/workspaces",
        json={"name": "Team Alpha", "description": "Test workspace"},
        params={"owner_user_id": owner_id},
    )
    assert r.status_code == 201
    ws = r.json()
    ws_id = ws["id"]
    assert ws["owner_user_id"] == owner_id

    # Get
    r = client.get(f"/api/workspaces/{ws_id}")
    assert r.status_code == 200

    # List
    r = client.get("/api/workspaces")
    assert r.status_code == 200
    assert len(r.json()) >= 1

    # 404
    r = client.get("/api/workspaces/nonexistent")
    assert r.status_code == 404


def test_invitation_flow(client: TestClient):
    # Setup: user + workspace
    r = client.post("/api/users", json={"display_name": "Inviter"})
    owner_id = r.json()["id"]
    r = client.post(
        "/api/workspaces",
        json={"name": "Invite WS"},
        params={"owner_user_id": owner_id},
    )
    ws_id = r.json()["id"]

    # Create invitation
    r = client.post(
        "/api/invitations",
        json={"workspace_id": ws_id, "invited_name": "Bob", "invited_email": "bob@test.com"},
    )
    assert r.status_code == 201
    inv = r.json()
    token = inv["token"]
    assert inv["status"] == "pending"

    # Accept invitation
    r = client.post("/api/invitations/accept", json={"token": token})
    assert r.status_code == 200
    assert r.json()["status"] == "accepted"
    assert r.json()["accepted_at"] is not None

    # Accept again should fail
    r = client.post("/api/invitations/accept", json={"token": token})
    assert r.status_code == 400

    # Invalid token
    r = client.post("/api/invitations/accept", json={"token": "bad-token"})
    assert r.status_code == 400


def test_member_profile_crud(client: TestClient):
    # Setup
    r = client.post("/api/users", json={"display_name": "ProfileUser"})
    user_id = r.json()["id"]
    r = client.post(
        "/api/workspaces",
        json={"name": "Profile WS"},
        params={"owner_user_id": user_id},
    )
    ws_id = r.json()["id"]

    # Create profile
    r = client.post(
        "/api/member-profiles",
        json={
            "user_id": user_id,
            "workspace_id": ws_id,
            "skills": ["python", "design"],
            "available_hours_per_week": 20,
            "role_preference": "developer",
            "interests": "AI",
            "constraints": "weekends only",
        },
    )
    assert r.status_code == 201
    profile = r.json()
    profile_id = profile["id"]
    assert profile["skills"] == ["python", "design"]

    # Get
    r = client.get(f"/api/member-profiles/{profile_id}")
    assert r.status_code == 200

    # Update
    r = client.patch(f"/api/member-profiles/{profile_id}", json={"available_hours_per_week": 30})
    assert r.status_code == 200
    assert r.json()["available_hours_per_week"] == 30.0

    # List by workspace
    r = client.get(f"/api/workspaces/{ws_id}/profiles")
    assert r.status_code == 200
    assert len(r.json()) >= 1

    # 404 on get
    r = client.get("/api/member-profiles/nonexistent")
    assert r.status_code == 404


def test_add_member_duplicate(client: TestClient):
    # Setup
    r = client.post("/api/users", json={"display_name": "MemberUser"})
    user_id = r.json()["id"]
    r = client.post(
        "/api/workspaces",
        json={"name": "Member WS"},
        params={"owner_user_id": user_id},
    )
    ws_id = r.json()["id"]

    # Owner is already a member, adding again should 409
    r = client.post(
        f"/api/workspaces/{ws_id}/members",
        json={"user_id": user_id, "role": "member"},
    )
    assert r.status_code == 409
