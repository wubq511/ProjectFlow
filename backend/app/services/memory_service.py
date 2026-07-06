"""Memory service: write path, visibility, read, and Markdown export for ProjectMemory.

Key invariants:
- extract_from_event runs synchronously after business commit, swallows exceptions
- Idempotent write: same source_hash → skip; changed source_hash → supersede
- Viewer identity is explicit; missing/invalid → error; no fallback to owner
- JSON list, Markdown export, and visibility logic must be consistent
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from sqlmodel import Session, select

from app.agent.memory.extractor import (
    EXTRACTOR_VERSION,
    ProjectMemoryCandidate,
    extract_direction_card_confirmed,
    extract_proposal_rejected,
    extract_assignment_confirmed,
    extract_replan_confirmed,
    extract_replan_rejected,
)
from app.agent.memory.retriever import MemoryBackend, MemoryRetriever, RetrievalResult
from app.core.database import engine as _default_engine
from app.models import (
    AgentProposal,
    AssignmentProposal,
    Project,
    ProjectMemory,
    ProjectMemorySync,
    Task,
    Stage,
    User,
    WorkspaceMembership,
)
from app.models.enums import MemorySourceType

logger = logging.getLogger(__name__)

# Module-level engine for memory session; can be patched in tests.
_memory_engine = _default_engine


def set_memory_engine(eng) -> None:
    """Override the engine used by extract_from_event (for tests)."""
    global _memory_engine
    _memory_engine = eng


def get_memory_engine():
    """Return the current memory engine."""
    return _memory_engine


# ─── Source type → extractor dispatch ────────────────────────────────────────

# AgentProposal-based extractors
_AGENT_PROPOSAL_EXTRACTORS = {
    "direction_card_confirmed": extract_direction_card_confirmed,
    "proposal_rejected": extract_proposal_rejected,
    "replan_confirmed": extract_replan_confirmed,
    "replan_rejected": extract_replan_rejected,
}

# AssignmentProposal-based extractors
_ASSIGNMENT_PROPOSAL_EXTRACTORS = {
    "assignment_confirmed": extract_assignment_confirmed,
}

# All registered source types
_EXTRACTOR_DISPATCH = set(_AGENT_PROPOSAL_EXTRACTORS) | set(_ASSIGNMENT_PROPOSAL_EXTRACTORS)


# ─── Write path ─────────────────────────────────────────────────────────────


def extract_from_event(source_type: str, source_id: str) -> None:
    """从 Memory Source Event 抽取 ProjectMemory。

    在业务 service session.commit() 之后同步调用，包在 try/except 里。
    内部开新 session 写 ProjectMemory。
    失败只记日志，不抛异常，不回滚业务决策。

    支持 AgentProposal-based 和 AssignmentProposal-based 两种 source type。
    """
    try:
        if source_type not in _EXTRACTOR_DISPATCH:
            logger.warning("No extractor registered for source_type=%s", source_type)
            return

        with Session(_memory_engine) as mem_session:
            # ── AgentProposal-based extractors ──
            if source_type in _AGENT_PROPOSAL_EXTRACTORS:
                extractor_fn = _AGENT_PROPOSAL_EXTRACTORS[source_type]
                proposal = mem_session.get(AgentProposal, source_id)
                if proposal is None:
                    logger.error("AgentProposal %s not found for memory extraction", source_id)
                    return

                project = mem_session.get(Project, proposal.project_id)
                if project is None:
                    logger.error("Project %s not found for memory extraction", proposal.project_id)
                    return

                candidates = extractor_fn(
                    mem_session,
                    proposal=proposal,
                    project=project,
                )
                workspace_id = proposal.workspace_id
                project_id = proposal.project_id

            # ── AssignmentProposal-based extractors ──
            elif source_type in _ASSIGNMENT_PROPOSAL_EXTRACTORS:
                extractor_fn = _ASSIGNMENT_PROPOSAL_EXTRACTORS[source_type]
                assignment_proposal = mem_session.get(AssignmentProposal, source_id)
                if assignment_proposal is None:
                    logger.error("AssignmentProposal %s not found for memory extraction", source_id)
                    return

                project = mem_session.get(Project, assignment_proposal.project_id)
                if project is None:
                    logger.error("Project %s not found for memory extraction", assignment_proposal.project_id)
                    return

                task = mem_session.get(Task, assignment_proposal.task_id)
                if task is None:
                    logger.error("Task %s not found for memory extraction", assignment_proposal.task_id)
                    return

                stage = mem_session.get(Stage, assignment_proposal.stage_id)
                if stage is None:
                    logger.error("Stage %s not found for memory extraction", assignment_proposal.stage_id)
                    return

                candidates = extractor_fn(
                    mem_session,
                    assignment_proposal=assignment_proposal,
                    project=project,
                    task=task,
                    stage=stage,
                )
                workspace_id = project.workspace_id
                project_id = assignment_proposal.project_id

            else:
                # Should not reach here due to the check above
                return

            if not candidates:
                logger.info(
                    "Extractor produced no candidates for %s/%s",
                    source_type,
                    source_id,
                )
                return

            # Idempotent write
            written = _write_candidates(
                mem_session,
                workspace_id=workspace_id,
                project_id=project_id,
                candidates=candidates,
                extractor_version=EXTRACTOR_VERSION,
            )

            mem_session.commit()

            logger.info(
                "ProjectMemory extraction: source_type=%s source_id=%s candidates=%d written=%d",
                source_type,
                source_id,
                len(candidates),
                len(written),
            )
    except Exception:
        logger.exception(
            "ProjectMemory extraction failed for %s/%s",
            source_type,
            source_id,
        )


def _write_candidates(
    session: Session,
    *,
    workspace_id: str,
    project_id: str,
    candidates: list[ProjectMemoryCandidate],
    extractor_version: str,
) -> list[ProjectMemory]:
    """幂等写入 candidates 到 ProjectMemory + ProjectMemorySync。

    规则：
    1. 同 (project_id, source_type, source_id, memory_type, source_hash) → skip
    2. 同 (project_id, source_type, source_id, memory_type) 有 active memory 但 source_hash 不同 → supersede
    3. 全新 → create
    """
    written: list[ProjectMemory] = []
    retriever = MemoryRetriever(session.connection())

    for cand in candidates:
        # Rule 1: Check idempotent key (same source_hash)
        existing = session.exec(
            select(ProjectMemory).where(
                ProjectMemory.project_id == project_id,
                ProjectMemory.source_type == cand.source_type,
                ProjectMemory.source_id == cand.source_id,
                ProjectMemory.memory_type == cand.memory_type,
                ProjectMemory.source_hash == cand.source_hash,
            )
        ).first()

        if existing is not None:
            # Same source_hash → skip (idempotent replay)
            logger.debug(
                "Idempotent skip: %s/%s/%s hash=%s",
                cand.source_type,
                cand.source_id,
                cand.memory_type,
                cand.source_hash[:12],
            )
            continue

        # Rule 2: Check for active memory with same (project, source_type, source_id, memory_type) but different hash
        active_same_key = session.exec(
            select(ProjectMemory).where(
                ProjectMemory.project_id == project_id,
                ProjectMemory.source_type == cand.source_type,
                ProjectMemory.source_id == cand.source_id,
                ProjectMemory.memory_type == cand.memory_type,
                ProjectMemory.status == "active",
            )
        ).first()

        # Create new memory
        now = datetime.now(UTC)
        new_memory = ProjectMemory(
            id=str(uuid.uuid4()),
            workspace_id=workspace_id,
            project_id=project_id,
            memory_type=cand.memory_type,
            scope=cand.scope,
            content=cand.content,
            rationale=cand.rationale,
            source_type=cand.source_type,
            source_id=cand.source_id,
            source_hash=cand.source_hash,
            status="active",
            visibility=cand.visibility,
            subject_user_id=cand.subject_user_id,
            owner_user_id_snapshot=cand.owner_user_id_snapshot,
            related_stage_id=cand.related_stage_id,
            related_task_id=cand.related_task_id,
            related_risk_id=cand.related_risk_id,
            valid_until=cand.valid_until,
            extractor_version=extractor_version,
            schema_version="pm-schema-v1",
            created_at=now,
            updated_at=now,
        )
        session.add(new_memory)
        session.flush()  # Get the ID

        # Index the new memory for FTS5 retrieval
        retriever.index_memory(new_memory)

        # Supersede old active memory if exists
        if active_same_key is not None:
            _supersede_memory(session, active_same_key, new_memory.id)

        # Create sync record (best effort, FTS5 not yet implemented)
        sync_record = ProjectMemorySync(
            memory_id=new_memory.id,
            backend="fts5",
            sync_status="pending",
        )
        session.add(sync_record)

        written.append(new_memory)

    return written


def _supersede_memory(
    session: Session, old_memory: ProjectMemory, new_memory_id: str
) -> None:
    """标记旧记忆为 superseded，并从 FTS5 索引中删除。"""
    old_memory.status = "superseded"
    old_memory.superseded_by_memory_id = new_memory_id
    old_memory.updated_at = datetime.now(UTC)
    session.add(old_memory)

    # Remove superseded memory from FTS5 index to avoid wasting retrieval slots
    try:
        retriever = MemoryRetriever(session.connection())
        if retriever._fts_available:
            session.connection().execute(
                text(f"DELETE FROM {MemoryRetriever._FTS_TABLE} WHERE memory_id = :memory_id"),
                {"memory_id": old_memory.id},
            )
    except Exception:
        logger.exception("Failed to remove superseded memory %s from FTS5", old_memory.id)


# ─── Viewer identity validation ─────────────────────────────────────────────


def validate_viewer(
    session: Session, *, project_id: str, viewer_user_id: str
) -> tuple[Project, WorkspaceMembership]:
    """验证 viewer_user_id 并返回 (project, membership)。

    Raises ValueError if:
    - viewer_user_id is empty/blank
    - user does not exist
    - user is not a member of the project's workspace
    """
    if not viewer_user_id or not viewer_user_id.strip():
        raise ValueError("viewer_user_id 不能为空")

    # Check user exists
    user = session.get(User, viewer_user_id)
    if user is None:
        raise ValueError(f"用户 {viewer_user_id} 不存在")

    # Check project exists and get workspace
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError("项目不存在")

    # Check workspace membership
    membership = session.exec(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == project.workspace_id,
            WorkspaceMembership.user_id == viewer_user_id,
        )
    ).first()

    if membership is None:
        raise ValueError(f"用户 {viewer_user_id} 不是该项目所在工作区的成员")

    return project, membership


# ─── Visibility logic ───────────────────────────────────────────────────────


def can_view_memory(
    memory: ProjectMemory, *, viewer_user_id: str, workspace_member_ids: set[str]
) -> bool:
    """判断 viewer 是否可以查看该记忆。

    - team → viewer 在 workspace 内即可
    - subject_and_owner → viewer == subject_user_id 或 viewer == owner_user_id_snapshot
    - 缺少 subject/owner → fail closed, 返回 False
    """
    if memory.visibility == "team":
        return viewer_user_id in workspace_member_ids

    if memory.visibility == "subject_and_owner":
        # Fail closed: must have both subject and owner
        if not memory.subject_user_id or not memory.owner_user_id_snapshot:
            return False
        return viewer_user_id in {memory.subject_user_id, memory.owner_user_id_snapshot}

    # Unknown visibility → fail closed
    return False


def get_workspace_member_ids(session: Session, workspace_id: str) -> set[str]:
    """获取 workspace 所有成员的 user_id 集合。"""
    memberships = session.exec(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id
        )
    ).all()
    return {m.user_id for m in memberships}


def get_visible_memories(
    session: Session, *, project_id: str, viewer_user_id: str
) -> list[ProjectMemory]:
    """获取 viewer 可见的 active 记忆列表。"""
    project, _ = validate_viewer(session, project_id=project_id, viewer_user_id=viewer_user_id)

    member_ids = get_workspace_member_ids(session, project.workspace_id)

    # Load all active memories for the project
    all_memories = session.exec(
        select(ProjectMemory).where(
            ProjectMemory.project_id == project_id,
            ProjectMemory.status == "active",
        )
    ).all()

    # Filter by visibility
    now = datetime.now(UTC)
    visible: list[ProjectMemory] = []
    for mem in all_memories:
        # Check expiry
        if mem.valid_until is not None and mem.valid_until < now:
            continue
        # Check visibility
        if can_view_memory(mem, viewer_user_id=viewer_user_id, workspace_member_ids=member_ids):
            visible.append(mem)

    return visible


def retrieve_visible_memory_ids(
    session: Session,
    *,
    project_id: str,
    viewer_user_id: str,
    query: str = "",
    limit: int = 50,
) -> RetrievalResult:
    """Retrieve visible candidate memory IDs using the same can_view_memory logic.

    This is the service-level entry point reused by context injection, JSON list,
    and Markdown export consistency checks.
    """
    from app.agent.memory.retriever import retrieve_memory_ids

    return retrieve_memory_ids(
        session,
        project_id=project_id,
        query=query,
        viewer_user_id=viewer_user_id,
        limit=limit,
    )


# ─── Markdown export ────────────────────────────────────────────────────────

_SOURCE_TYPE_CN = {
    "direction_card_confirmed": "方向卡确认",
    "proposal_rejected": "方案拒绝",
    "assignment_confirmed": "分工确认",
    "replan_confirmed": "重排确认",
    "replan_rejected": "重排拒绝",
}

_VISIBILITY_CN = {
    "team": "团队可见",
    "subject_and_owner": "相关成员和负责人可见",
}

_STATUS_CN = {
    "active": "有效",
    "superseded": "已被替代",
    "archived": "已归档",
}

# 5 个主题分组，按 memory_type 归类
_TOPIC_GROUPS = [
    ("方向与边界", {"direction", "boundary"}),
    ("被拒绝方案", {"rejection"}),
    ("分工与资源", {"assignment", "member_constraint"}),
    ("重排取舍", {"plan", "tradeoff"}),
    ("被替代或归档的历史判断", set()),  # superseded/archived
]


def export_memories_markdown(
    memories: list[ProjectMemory],
    *,
    project_name: str,
) -> str:
    """按 5 个主题聚合渲染 Markdown。"""
    lines: list[str] = []
    lines.append(f"# 项目「{project_name}」的记忆")
    lines.append("")

    # Separate active and historical
    active_memories = [m for m in memories if m.status == "active"]
    historical_memories = [m for m in memories if m.status in ("superseded", "archived")]

    for topic_title, type_set in _TOPIC_GROUPS:
        if topic_title == "被替代或归档的历史判断":
            group = historical_memories
        else:
            group = [m for m in active_memories if m.memory_type in type_set]

        if not group:
            continue

        lines.append(f"## {topic_title}")
        lines.append("")

        for mem in group:
            lines.append(f"### {mem.content}")
            lines.append(f"- 理由：{mem.rationale}")
            lines.append(f"- 来源：{_SOURCE_TYPE_CN.get(mem.source_type, mem.source_type)}")
            lines.append(f"- 状态：{_STATUS_CN.get(mem.status, mem.status)}")
            valid_str = mem.valid_until.isoformat() if mem.valid_until else "长期"
            lines.append(f"- 有效期：{valid_str}")
            lines.append(f"- 可见范围：{_VISIBILITY_CN.get(mem.visibility, mem.visibility)}")
            lines.append("")

    return "\n".join(lines)
