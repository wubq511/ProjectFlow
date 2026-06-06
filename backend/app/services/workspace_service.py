from sqlmodel import Session, select

from app.models.enums import WorkspaceRole
from app.models.workspace import Workspace, WorkspaceMembership
from app.schemas.workspace import WorkspaceCreate


def create_workspace(session: Session, data: WorkspaceCreate, owner_user_id: str) -> Workspace:
    workspace = Workspace(
        name=data.name,
        owner_user_id=owner_user_id,
        description=data.description,
        team_size=data.team_size,
        use_case=data.use_case,
    )
    session.add(workspace)
    session.flush()

    membership = WorkspaceMembership(
        workspace_id=workspace.id,
        user_id=owner_user_id,
        role=WorkspaceRole.owner,
    )
    session.add(membership)
    session.commit()
    session.refresh(workspace)
    return workspace


def get_workspace(session: Session, workspace_id: str) -> Workspace | None:
    return session.get(Workspace, workspace_id)


def list_workspaces(session: Session) -> list[Workspace]:
    return list(session.exec(select(Workspace)).all())


def add_member(session: Session, workspace_id: str, user_id: str, role: WorkspaceRole) -> WorkspaceMembership:
    # Check for duplicate membership
    existing = session.exec(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.user_id == user_id,
        )
    ).first()
    if existing:
        raise ValueError(f"User {user_id} is already a member of workspace {workspace_id}")

    membership = WorkspaceMembership(
        workspace_id=workspace_id,
        user_id=user_id,
        role=role,
    )
    session.add(membership)
    session.commit()
    session.refresh(membership)
    return membership


def remove_member(session: Session, workspace_id: str, user_id: str) -> None:
    membership = session.exec(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.user_id == user_id,
        )
    ).first()
    if membership:
        session.delete(membership)
        session.commit()
