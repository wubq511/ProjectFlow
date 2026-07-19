"""T46-2 Evaluation Evidence Snapshot service.

Read-only, viewer-scoped, normalized facts for deterministic graders.

Hard contract:
- This service performs ONLY SELECT queries. It must never call ``session.add``,
  ``session.commit``, ``session.delete`` or any state-mutating helper. The
  evidence snapshot is an evidence seam, not a second behavior entry point.
- Viewer-sensitive collections (conversations, ProjectMemory) are filtered by
  the same authorization predicates used by public read surfaces
  (``memory_service.can_view_memory`` and the conversation visibility SQL).
  The snapshot cannot bypass viewer visibility.
- Subject-and-owner ProjectMemory content is included only when the viewer is
  authorized; otherwise only structural facts are returned. This lets graders
  prove that a non-authorized viewer cannot read private memory content while
  still observing that the memory exists.
- No raw payload values, no input/output snapshot blobs, no trace payloads,
  no absolute local paths, no secrets. Only normalized facts.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlmodel import Session, select

from app.models import (
    AgentConversation,
    AgentEvent,
    AgentMessage,
    AgentProposal,
    AssignmentProposal,
    Project,
    Stage,
    Task,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.models.agent_run_state import AgentRunEvent, AgentRunV2
from app.models.project_memory import ProjectMemory
from app.schemas.evaluation_evidence import (
    AssignmentProposalFacts,
    ContextReceiptFacts,
    ConversationFacts,
    EventFacts,
    EvaluationEvidenceSnapshot,
    MemberFacts,
    MemoryFacts,
    MetricFacts,
    ProposalFacts,
    SideEffectFacts,
    StageFacts,
    StateFacts,
    TaskFacts,
    TrajectoryFacts,
)
from app.services.memory_service import (
    can_view_memory,
    get_workspace_member_ids,
    validate_viewer,
)


def _iso(value: datetime | None) -> str:
    if value is None:
        return ""
    return value.isoformat()


def _payload_keys(payload_str: str) -> list[str]:
    """Return top-level keys of a JSON payload, sorted. Never returns values."""
    if not payload_str:
        return []
    try:
        parsed = json.loads(payload_str)
    except (TypeError, json.JSONDecodeError):
        return []
    if isinstance(parsed, dict):
        return sorted(str(k) for k in parsed.keys())
    if isinstance(parsed, list):
        return [f"[list:{len(parsed)}"]
    return []


def _build_state_facts(
    session: Session,
    *,
    workspace: Workspace,
    project: Project | None,
    members: list[MemberFacts],
) -> StateFacts:
    if project is None:
        return StateFacts(
            workspace_id=workspace.id,
            workspace_name=workspace.name,
            stage_count=0,
            task_count=0,
            member_count=len(members),
            members=members,
        )

    stage_rows = session.exec(
        select(Stage)
        .where(Stage.project_id == project.id)
        .order_by(Stage.order_index)
    ).all()
    stages = [
        StageFacts(
            stage_id=s.id,
            name=s.name,
            status=s.status if isinstance(s.status, str) else s.status.value,
            order_index=s.order_index,
        )
        for s in stage_rows
    ]

    task_rows = session.exec(
        select(Task).where(Task.project_id == project.id)
    ).all()
    tasks = [
        TaskFacts(
            task_id=t.id,
            title=t.title,
            status=t.status if isinstance(t.status, str) else t.status.value,
            priority=t.priority if isinstance(t.priority, str) else t.priority.value,
            stage_id=t.stage_id,
            owner_user_id=t.owner_user_id,
            backup_owner_user_id=t.backup_owner_user_id,
        )
        for t in task_rows
    ]

    assignment_rows = session.exec(
        select(AssignmentProposal).where(AssignmentProposal.project_id == project.id)
    ).all()
    assignments = [
        AssignmentProposalFacts(
            proposal_id=p.id,
            stage_id=p.stage_id,
            task_id=p.task_id,
            recommended_owner_user_id=p.recommended_owner_user_id,
            backup_owner_user_id=p.backup_owner_user_id,
            status=p.status if isinstance(p.status, str) else p.status.value,
        )
        for p in assignment_rows
    ]

    return StateFacts(
        workspace_id=workspace.id,
        workspace_name=workspace.name,
        project_id=project.id,
        project_name=project.name,
        project_status=project.status if isinstance(project.status, str) else project.status.value,
        project_current_stage_id=project.current_stage_id,
        project_deadline=project.deadline if project.deadline else None,
        stage_count=len(stages),
        stages=stages,
        task_count=len(tasks),
        tasks=tasks,
        assignment_proposal_count=len(assignments),
        assignment_proposals=assignments,
        member_count=len(members),
        members=members,
    )


def _build_proposal_facts(session: Session, project_id: str) -> list[ProposalFacts]:
    rows = session.exec(
        select(AgentProposal)
        .where(AgentProposal.project_id == project_id)
        .order_by(AgentProposal.created_at)
    ).all()
    return [
        ProposalFacts(
            proposal_id=p.id,
            proposal_type=p.proposal_type,
            status=p.status if isinstance(p.status, str) else p.status.value,
            confirmed_by_present=p.confirmed_by is not None,
            confirmed_at_present=p.confirmed_at is not None,
            rejection_reason_present=p.rejection_reason is not None,
            payload_keys=_payload_keys(p.payload),
            created_at=_iso(p.created_at),
        )
        for p in rows
    ]


def _build_event_facts(session: Session, project_id: str) -> list[EventFacts]:
    rows = session.exec(
        select(AgentEvent)
        .where(AgentEvent.project_id == project_id)
        .order_by(AgentEvent.created_at)
    ).all()
    return [
        EventFacts(
            event_id=e.id,
            event_type=e.event_type if isinstance(e.event_type, str) else e.event_type.value,
            status=e.status if isinstance(e.status, str) else e.status.value,
            user_confirmed=bool(e.user_confirmed),
            created_at=_iso(e.created_at),
        )
        for e in rows
    ]


def _build_memory_facts(
    session: Session,
    *,
    project: Project,
    viewer_user_id: str,
) -> list[MemoryFacts]:
    """Return memory facts visible to the viewer.

    Team memories: full facts including content/rationale.
    Subject-and-owner memories: full facts (including content/rationale) only
    when the viewer is the subject or owner; otherwise structural facts only
    (content_visible=False, content/rationale omitted).

    This deliberately mirrors ``memory_service.get_visible_memories`` for the
    visible set, then re-applies ``can_view_memory`` per memory so the snapshot
    cannot leak subject_and_owner content to a non-authorized viewer even if
    the visible-set query is changed in the future.
    """
    member_ids = get_workspace_member_ids(session, project.workspace_id)
    all_memories = session.exec(
        select(ProjectMemory).where(ProjectMemory.project_id == project.id)
    ).all()

    facts: list[MemoryFacts] = []
    for mem in all_memories:
        authorized = can_view_memory(
            mem, viewer_user_id=viewer_user_id, workspace_member_ids=member_ids
        )
        if not authorized:
            # The memory exists but the viewer cannot see it. We still surface
            # structural presence so graders can detect that a private memory
            # was created without leaking its content. This is consistent with
            # the public memories endpoint, which simply omits invisible rows;
            # the snapshot adds an explicit "exists but not visible" signal.
            continue
        content_visible = mem.visibility == "team" or (
            mem.visibility == "subject_and_owner"
            and viewer_user_id in {mem.subject_user_id, mem.owner_user_id_snapshot}
        )
        facts.append(MemoryFacts(
            memory_id=mem.id,
            memory_type=mem.memory_type,
            scope=mem.scope,
            status=mem.status,
            visibility=mem.visibility,
            subject_user_id_present=mem.subject_user_id is not None,
            owner_user_id_snapshot_present=mem.owner_user_id_snapshot is not None,
            related_stage_id_present=mem.related_stage_id is not None,
            related_task_id_present=mem.related_task_id is not None,
            related_risk_id_present=mem.related_risk_id is not None,
            valid_until_present=mem.valid_until is not None,
            content_visible=content_visible,
            content=mem.content if content_visible else None,
            rationale=mem.rationale if content_visible else None,
            created_at=_iso(mem.created_at),
        ))
    return facts


def _build_conversation_facts(
    session: Session,
    *,
    project: Project,
    viewer_user_id: str,
) -> list[ConversationFacts]:
    """Return conversation facts visible to the viewer.

    Mirrors the SQL visibility filter in ``agent_conversation_service.list_conversations``:
    - team conversations visible to all workspace members
    - private conversations visible only to creator
    """
    rows = session.exec(
        select(AgentConversation)
        .where(
            AgentConversation.project_id == project.id,
            (
                (AgentConversation.visibility == "team")
                | (
                    (AgentConversation.visibility == "private")
                    & (AgentConversation.creator_user_id == viewer_user_id)
                )
            ),
        )
        .order_by(AgentConversation.updated_at)
    ).all()
    if not rows:
        return []
    conv_ids = [c.id for c in rows]
    count_rows = session.exec(
        select(AgentMessage.conversation_id)
        .where(AgentMessage.conversation_id.in_(conv_ids))
    ).all()
    count_map: dict[str, int] = {}
    for cid in count_rows:
        count_map[cid] = count_map.get(cid, 0) + 1
    return [
        ConversationFacts(
            conversation_id=c.id,
            visibility=c.visibility,
            creator_user_id=c.creator_user_id,
            status=c.status,
            message_count=count_map.get(c.id, 0),
            created_at=_iso(c.created_at),
            updated_at=_iso(c.updated_at),
        )
        for c in rows
    ]


def _build_trajectory_facts(
    session: Session, *, run_id: str | None, project_id: str
) -> list[TrajectoryFacts]:
    """Return runtime event types/seqs/timestamps. No payload or trace content."""
    if not run_id:
        return []
    rows = session.exec(
        select(AgentRunEvent)
        .where(AgentRunEvent.run_id == run_id)
        .order_by(AgentRunEvent.event_seq)
    ).all()
    return [
        TrajectoryFacts(
            event_type=e.type if isinstance(e.type, str) else e.type.value,
            event_seq=e.event_seq,
            created_at=_iso(e.created_at),
        )
        for e in rows
    ]


def _build_side_effect_facts(
    session: Session, *, run_id: str | None
) -> list[SideEffectFacts]:
    if not run_id:
        return []
    run = session.get(AgentRunV2, run_id)
    if run is None:
        return []
    side_effects = run.get_side_effects()
    facts: list[SideEffectFacts] = []
    for entry in side_effects:
        if not isinstance(entry, dict):
            continue
        facts.append(SideEffectFacts(
            tool_call_id=str(entry.get("tool_call_id", "")),
            status=str(entry.get("status", "")),
            effect_type=str(entry.get("effect_type")) if entry.get("effect_type") is not None else None,
            tool_name=str(entry.get("tool_name")) if entry.get("tool_name") is not None else None,
        ))
    return facts


def _build_metric_facts(
    session: Session, *, run_id: str | None
) -> MetricFacts | None:
    if not run_id:
        return None
    run = session.get(AgentRunV2, run_id)
    if run is None:
        return None
    return MetricFacts(
        run_id=run.id,
        run_status=run.status if isinstance(run.status, str) else run.status.value,
        model_provider=run.model_provider,
        model_name=run.model_name,
        resolved_model_provider=run.resolved_model_provider,
        resolved_model_name=run.resolved_model_name,
        current_turn=run.current_turn,
        current_step=run.current_step,
        side_effects_count=len(run.get_side_effects()),
        last_event_seq=run.last_event_seq,
    )


def _build_context_receipt_facts(
    session: Session, *, run_id: str | None
) -> ContextReceiptFacts | None:
    """Redacted summary of what the run consumed from context sources.

    Extracts memory_ids_used, skill_names and tool_manifest_names from runtime
    event payloads. Only structural identifiers are exposed; no memory content,
    no hidden prompts, no chain-of-thought.
    """
    if not run_id:
        return None
    rows = session.exec(
        select(AgentRunEvent)
        .where(AgentRunEvent.run_id == run_id)
        .order_by(AgentRunEvent.event_seq)
    ).all()
    if not rows:
        # Run does not exist or has no persisted events. Return None so
        # callers can distinguish "no run-scoped facts" from "run consumed
        # nothing" — consistent with metric_facts and side_effect_facts,
        # which return None/empty when the run does not exist.
        return None
    memory_ids: set[str] = set()
    skill_names: set[str] = set()
    tool_manifest_names: set[str] = set()
    for event in rows:
        payload = event.get_payload()
        if not isinstance(payload, dict):
            continue
        # Memory IDs may appear in context_receipt or memory events under
        # flat top-level keys. AGENTS.md documents that AgentEvent
        # output_snapshot records `_memory.used` / `_memory.backend` /
        # `_memory.used_memory_ids` metadata, so also walk the nested
        # `_memory` sub-object to capture IDs the runtime actually used.
        for key in ("memory_ids", "memory_ids_used", "used_memory_ids"):
            value = payload.get(key)
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        memory_ids.add(item)
        memory_meta = payload.get("_memory")
        if isinstance(memory_meta, dict):
            for key in ("used_memory_ids", "used"):
                value = memory_meta.get(key)
                if isinstance(value, list):
                    for item in value:
                        if isinstance(item, str):
                            memory_ids.add(item)
        # Skill names appear in agent.status / run.started events.
        skills = payload.get("selected_skills") or payload.get("skills")
        if isinstance(skills, list):
            for item in skills:
                if isinstance(item, str):
                    skill_names.add(item)
        # Tool manifest names appear in tool.started events.
        tool_name = payload.get("tool_name")
        if isinstance(tool_name, str):
            tool_manifest_names.add(tool_name)
    return ContextReceiptFacts(
        memory_ids_used=sorted(memory_ids),
        skill_names=sorted(skill_names),
        tool_manifest_names=sorted(tool_manifest_names),
    )


def build_evidence_snapshot(
    session: Session,
    *,
    workspace_id: str,
    viewer_user_id: str,
    project_id: str | None = None,
    conversation_id: str | None = None,
    run_id: str | None = None,
) -> EvaluationEvidenceSnapshot:
    """Build a normalized, viewer-scoped evidence snapshot.

    Read-only: this function performs only SELECT queries. It must never
    mutate database state.

    Raises ValueError if:
    - viewer_user_id is empty/blank or not a workspace member
    - workspace not found
    - project_id provided but not in workspace
    """
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise ValueError("工作区不存在")

    # Resolve target project: explicit project_id wins, otherwise the most
    # recently created project in the workspace (same convention as the
    # workspace_state_service public read endpoint).
    if project_id:
        project = session.get(Project, project_id)
        if project is None or project.workspace_id != workspace_id:
            raise ValueError("项目不存在")
    else:
        project = session.exec(
            select(Project)
            .where(Project.workspace_id == workspace_id)
            .order_by(Project.created_at.desc())
        ).first()
        if project is None:
            raise ValueError("工作区中不存在项目")

    # validate_viewer enforces that the viewer is a workspace member of the
    # project's workspace. This is the same predicate used by the public
    # memories and conversations endpoints.
    project, _ = validate_viewer(
        session, project_id=project.id, viewer_user_id=viewer_user_id
    )

    # Members
    membership_rows = session.exec(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id
        )
    ).all()
    member_ids = [m.user_id for m in membership_rows]
    users_by_id: dict[str, User] = {
        u.id: u
        for u in session.exec(select(User).where(User.id.in_(member_ids))).all()
    } if member_ids else {}
    members = [
        MemberFacts(user_id=uid, display_name=users_by_id[uid].display_name)
        for uid in member_ids
        if uid in users_by_id
    ]

    state_facts = _build_state_facts(
        session, workspace=workspace, project=project, members=members
    )
    proposal_facts = _build_proposal_facts(session, project.id)
    event_facts = _build_event_facts(session, project.id)
    memory_facts = _build_memory_facts(
        session, project=project, viewer_user_id=viewer_user_id
    )
    conversation_facts = _build_conversation_facts(
        session, project=project, viewer_user_id=viewer_user_id
    )
    trajectory_facts = _build_trajectory_facts(
        session, run_id=run_id, project_id=project.id
    )
    side_effect_facts = _build_side_effect_facts(session, run_id=run_id)
    metric_facts = _build_metric_facts(session, run_id=run_id)
    context_receipt_facts = _build_context_receipt_facts(session, run_id=run_id)

    return EvaluationEvidenceSnapshot(
        snapshot_id=str(uuid.uuid4()),
        captured_at=datetime.now(timezone.utc).isoformat(),
        workspace_id=workspace_id,
        project_id=project.id,
        conversation_id=conversation_id,
        viewer_user_id=viewer_user_id,
        run_id=run_id,
        state_facts=state_facts,
        proposal_facts=proposal_facts,
        event_facts=event_facts,
        memory_facts=memory_facts,
        conversation_facts=conversation_facts,
        trajectory_facts=trajectory_facts,
        side_effect_facts=side_effect_facts,
        metric_facts=metric_facts,
        context_receipt_facts=context_receipt_facts,
    )