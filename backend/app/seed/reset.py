"""Demo reset: clears all data from all tables."""

from sqlalchemy import text
from sqlmodel import Session, select

from app.models import (
    User,
    Workspace,
    WorkspaceMembership,
    Invitation,
    MemberProfile,
    Project,
    ProjectResource,
    Stage,
    Task,
    TaskStatusUpdate,
    AssignmentProposal,
    AssignmentResponse,
    AssignmentNegotiation,
    CheckInCycle,
    CheckInResponse,
    Risk,
    ActionCard,
    AgentEvent,
    AgentProposal,
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentRunEvent,
    AgentRunV2,
    AgentToolResource,
    ProjectMemory,
    ProjectMemorySync,
)

# All model tables in reverse dependency order (children first)
ALL_TABLES = [
    AgentRunEvent,
    AgentToolResource,
    AgentRunV2,
    AgentMessage,
    AgentRun,
    AgentConversation,
    ProjectMemorySync,
    ProjectMemory,
    AgentProposal,
    AgentEvent,
    ActionCard,
    Risk,
    CheckInResponse,
    CheckInCycle,
    AssignmentNegotiation,
    AssignmentResponse,
    AssignmentProposal,
    TaskStatusUpdate,
    Task,
    Stage,
    ProjectResource,
    Project,
    MemberProfile,
    Invitation,
    WorkspaceMembership,
    Workspace,
    User,
]


def reset_demo_data(session: Session) -> dict:
    """Delete all rows from all tables. Returns counts of deleted rows."""

    # Break FK cycle: Project.current_stage_id references Stage, but Stage
    # must be deleted before Project in the dependency-ordered loop above.
    # Nullify the pointer first so FK enforcement doesn't block the delete.
    session.exec(select(Project)).all()  # ensure autoflush has nothing pending
    session.execute(text("UPDATE projects SET current_stage_id = NULL"))

    deleted = {}
    for model in ALL_TABLES:
        rows = session.exec(select(model)).all()
        count = len(rows)
        for row in rows:
            session.delete(row)
        # Preserve the dependency order above. Relying on the next query's
        # autoflush makes omissions surface later as misleading parent-table
        # failures and obscures which model was not cleared.
        session.flush()
        deleted[model.__tablename__] = count

    session.commit()
    return {"deleted": deleted}
