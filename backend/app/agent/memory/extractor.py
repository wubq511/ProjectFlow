"""V1 Deterministic MemoryExtractor — 不调用 LLM。

读取 schema 校验后的 Memory Source Event payload 与关联实体展示字段，
通过固定规则和中文模板生成 ProjectMemory candidate。

关键约束：
- 所有用户可见文本使用 display_name/title/中文占位词，禁止 raw ID
- 不调用 LLM
- 同一 source event + 同一 memory_type 最多输出 1 条 candidate
- 多个 boundaries 聚合为 1 条 boundary
"""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass
from datetime import datetime

from sqlmodel import Session

from app.agent.memory.display_resolver import (
    resolve_project_name,
    resolve_display_name,
    resolve_task_title,
    resolve_stage_title,
)
from app.agent.output_schemas import DirectionCardOutput, ReplanOutput
from app.models import AgentProposal, AssignmentProposal, Project, Task, Stage


EXTRACTOR_VERSION = "det-v1.0-zh"


@dataclass
class ProjectMemoryCandidate:
    """Extractor 输出的候选记忆，不直接写 DB，供 memory_service 校验和幂等写入。"""

    memory_type: str
    scope: str
    content: str
    rationale: str
    source_type: str
    source_id: str
    source_hash: str
    visibility: str
    subject_user_id: str | None = None
    owner_user_id_snapshot: str | None = None
    related_stage_id: str | None = None
    related_task_id: str | None = None
    related_risk_id: str | None = None
    valid_until: datetime | None = None


def _compute_source_hash(stable_fields: dict) -> str:
    """对稳定字段做确定性 JSON 序列化 + SHA256。

    stable_fields 只包含影响抽取语义的字段，
    不包含 created_at/updated_at/requires_confirmation 等无关字段。
    """
    canonical = json.dumps(stable_fields, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _get_direction_card_stable_fields(output: DirectionCardOutput) -> dict:
    """提取 DirectionCardOutput 中影响抽取语义的稳定字段。"""
    return {
        "problem": output.problem,
        "users": output.users,
        "value": output.value,
        "deliverables": sorted(output.deliverables),
        "boundaries": sorted(output.boundaries) if output.boundaries else [],
        "mvp_boundary": output.mvp_boundary,
    }


def extract_direction_card_confirmed(
    session: Session,
    *,
    proposal: AgentProposal,
    project: Project,
) -> list[ProjectMemoryCandidate]:
    """direction_card_confirmed → 1 条 direction 记忆
    + payload 含 boundaries 时 → 1 条 boundary 记忆（多点稳定排序聚合）

    visibility=team, scope=project
    """
    # Parse and validate payload
    payload = proposal.payload
    if isinstance(payload, str):
        payload = json.loads(payload)
    output = DirectionCardOutput.model_validate(payload)

    project_name = resolve_project_name(session, project.id)
    source_hash = _compute_source_hash(_get_direction_card_stable_fields(output))
    candidates: list[ProjectMemoryCandidate] = []

    # ── direction 记忆 ──
    deliverables_cn = "、".join(output.deliverables)
    direction_content = (
        f"项目「{project_name}」的核心方向："
        f"解决{output.problem}，服务{output.users}，交付{output.value}。"
        f"主要交付物：{deliverables_cn}。"
    )
    direction_rationale = "方向卡确认时团队明确了项目方向。来源：方向卡确认。"

    candidates.append(
        ProjectMemoryCandidate(
            memory_type="direction",
            scope="project",
            content=direction_content,
            rationale=direction_rationale,
            source_type="direction_card_confirmed",
            source_id=proposal.id,
            source_hash=source_hash,
            visibility="team",
        )
    )

    # ── boundary 记忆（仅当 boundaries 非空）──
    if output.boundaries:
        # 稳定排序后聚合为 1 条
        sorted_boundaries = sorted(output.boundaries)
        boundaries_cn = "；".join(sorted_boundaries)
        boundary_content = f"项目「{project_name}」的范围边界：{boundaries_cn}。"
        boundary_rationale = "方向卡确认时团队明确了 MVP 和范围边界。来源：方向卡确认。"

        candidates.append(
            ProjectMemoryCandidate(
                memory_type="boundary",
                scope="project",
                content=boundary_content,
                rationale=boundary_rationale,
                source_type="direction_card_confirmed",
                source_id=proposal.id,
                source_hash=source_hash,
                visibility="team",
            )
        )

    return candidates


# ─── proposal_type 中文标签 ──────────────────────────────────────────────────

_PROPOSAL_TYPE_CN = {
    "clarify": "方向卡",
    "plan": "阶段计划",
    "breakdown": "任务分解",
    "replan": "计划调整",
}


def _get_proposal_rejected_stable_fields(
    proposal: AgentProposal,
    rejection_reason: str,
) -> dict:
    """提取 proposal rejection 中影响抽取语义的稳定字段。"""
    return {
        "proposal_type": proposal.proposal_type,
        "rejection_reason": rejection_reason,
    }


def extract_proposal_rejected(
    session: Session,
    *,
    proposal: AgentProposal,
    project: Project,
) -> list[ProjectMemoryCandidate]:
    """proposal_rejected → 1 条 rejection 记忆（仅当 rejection_reason 非空）。

    前置条件：调用方已确认 rejection_reason 非空且非空白。
    visibility=team, scope=project
    source_id=AgentProposal.id（不创建 AgentEvent）
    """
    rejection_reason = (proposal.rejection_reason or "").strip()
    if not rejection_reason:
        # 空 reason → 不产生 ProjectMemory
        return []

    project_name = resolve_project_name(session, project.id)
    proposal_label = _PROPOSAL_TYPE_CN.get(proposal.proposal_type, proposal.proposal_type)

    source_hash = _compute_source_hash(
        _get_proposal_rejected_stable_fields(proposal, rejection_reason)
    )

    # content: 说明哪个方案未被采纳
    content = f"项目「{project_name}」的{proposal_label}方案未被采纳。"

    # rationale: 只引用显式拒绝理由，不推断隐藏因果
    rationale = f"拒绝理由：{rejection_reason}。来源：方案拒绝。"

    candidates: list[ProjectMemoryCandidate] = [
        ProjectMemoryCandidate(
            memory_type="rejection",
            scope="project",
            content=content,
            rationale=rationale,
            source_type="proposal_rejected",
            source_id=proposal.id,
            source_hash=source_hash,
            visibility="team",
        )
    ]

    return candidates


# ─── assignment_confirmed extractor ──────────────────────────────────────────


def _get_assignment_confirmed_stable_fields(
    assignment_proposal: AssignmentProposal,
    task_title: str,
    owner_display_name: str,
) -> dict:
    """提取 assignment finalization 中影响抽取语义的稳定字段。"""
    stable: dict = {
        "task_id": assignment_proposal.task_id,
        "task_title": task_title,
        "recommended_owner_user_id": assignment_proposal.recommended_owner_user_id,
        "owner_display_name": owner_display_name,
        "reason": assignment_proposal.reason,
    }
    if assignment_proposal.backup_owner_user_id:
        stable["backup_owner_user_id"] = assignment_proposal.backup_owner_user_id
    if assignment_proposal.constraint_respected:
        stable["constraint_respected"] = assignment_proposal.constraint_respected
    return stable


def extract_assignment_confirmed(
    session: Session,
    *,
    assignment_proposal: AssignmentProposal,
    project: Project,
    task: Task,
    stage: Stage,
) -> list[ProjectMemoryCandidate]:
    """assignment_confirmed → 1 条 team-visible assignment 记忆
    + 可选 1 条 member_constraint 记忆（仅当 constraint_respected 非空且仅涉及单个 subject）。

    member_constraint 使用 visibility=subject_and_owner：
    - subject_user_id = assignment_proposal.recommended_owner_user_id
    - owner_user_id_snapshot = project.created_by（项目创建者作为 owner snapshot）

    多成员 private constraints → 跳过，不聚合也不拆分。
    缺少 subject 或 owner → fail closed，不写 member_constraint。
    """
    project_name = resolve_project_name(session, project.id)
    task_title = resolve_task_title(session, task.id)
    owner_name = resolve_display_name(session, assignment_proposal.recommended_owner_user_id)

    source_hash = _compute_source_hash(
        _get_assignment_confirmed_stable_fields(
            assignment_proposal, task_title, owner_name
        )
    )

    candidates: list[ProjectMemoryCandidate] = []

    # ── assignment 记忆（team-visible）──
    backup_clause = ""
    if assignment_proposal.backup_owner_user_id:
        backup_name = resolve_display_name(session, assignment_proposal.backup_owner_user_id)
        backup_clause = f"，备选负责人为{backup_name}"

    assignment_content = (
        f"项目「{project_name}」的「{task_title}」任务"
        f"由{owner_name}负责{backup_clause}。"
        f"分工理由：{assignment_proposal.reason}。"
    )
    assignment_rationale = (
        "分工确认时团队明确了任务负责人。来源：分工确认。"
    )

    candidates.append(
        ProjectMemoryCandidate(
            memory_type="assignment",
            scope="task",
            content=assignment_content,
            rationale=assignment_rationale,
            source_type="assignment_confirmed",
            source_id=assignment_proposal.id,
            source_hash=source_hash,
            visibility="team",
            related_stage_id=stage.id,
            related_task_id=task.id,
        )
    )

    # ── member_constraint 记忆（subject_and_owner）──
    # 仅当 constraint_respected 非空时考虑
    constraint_text = (assignment_proposal.constraint_respected or "").strip()
    if constraint_text:
        subject_user_id = assignment_proposal.recommended_owner_user_id
        owner_user_id_snapshot = project.created_by

        # Fail closed: 必须同时有 subject 和 owner
        if subject_user_id and owner_user_id_snapshot:
            # 单成员约束 → 写 member_constraint
            constraint_content = (
                f"{owner_name}的约束：{constraint_text}。"
                f"来源：项目「{project_name}」的分工确认。"
            )
            constraint_rationale = (
                "分工确认时捕获了成员的可用性或偏好约束。来源：分工确认。"
            )

            candidates.append(
                ProjectMemoryCandidate(
                    memory_type="member_constraint",
                    scope="member",
                    content=constraint_content,
                    rationale=constraint_rationale,
                    source_type="assignment_confirmed",
                    source_id=assignment_proposal.id,
                    source_hash=source_hash,
                    visibility="subject_and_owner",
                    subject_user_id=subject_user_id,
                    owner_user_id_snapshot=owner_user_id_snapshot,
                    related_stage_id=stage.id,
                    related_task_id=task.id,
                )
            )
        # else: 缺少 subject 或 owner → fail closed，不写 member_constraint
        # 不降级为 team

    return candidates


# ─── replan_confirmed extractor ─────────────────────────────────────────────


def _get_replan_confirmed_stable_fields(output: ReplanOutput) -> dict:
    """提取 ReplanOutput 中影响抽取语义的稳定字段。"""
    stage_adjs = sorted(
        [
            {
                "stage_id": adj.stage_id,
                "new_start_date": adj.new_start_date.isoformat() if adj.new_start_date else None,
                "new_end_date": adj.new_end_date.isoformat() if adj.new_end_date else None,
                "reason": adj.reason,
            }
            for adj in output.stage_adjustments
        ],
        key=lambda x: x["stage_id"],
    )
    task_chgs = sorted(
        [
            {
                "task_id": tc.task_id,
                "title": tc.title,
                "status": tc.status.value if tc.status else None,
                "owner_user_id": tc.owner_user_id,
                "due_date": tc.due_date.isoformat() if tc.due_date else None,
                "can_cut": tc.can_cut,
                "reason": tc.reason,
            }
            for tc in output.task_changes
        ],
        key=lambda x: x["task_id"],
    )
    return {
        "impact": output.impact,
        "reason": output.reason,
        "stage_adjustments": stage_adjs,
        "task_changes": task_chgs,
    }


def _has_tradeoff_rationale(output: ReplanOutput) -> bool:
    """检查 replan 输出中是否包含显式的权衡/延迟/替换理由。"""
    for adj in output.stage_adjustments:
        if adj.reason.strip():
            return True
    for tc in output.task_changes:
        if tc.reason.strip():
            return True
    return False


def _has_boundary_rationale(output: ReplanOutput) -> bool:
    """检查 replan 输出中是否包含显式的范围边界变更理由。"""
    for tc in output.task_changes:
        if tc.can_cut is not None or (tc.status and tc.status.value in ("cancelled", "blocked")):
            return True
    return False


def extract_replan_confirmed(
    session: Session,
    *,
    proposal: AgentProposal,
    project: Project,
) -> list[ProjectMemoryCandidate]:
    """replan_confirmed → 1 条 plan 记忆
    + 显式权衡理由时 → 至多 1 条 tradeoff 记忆
    + 显式范围边界变更时 → 至多 1 条 boundary 记忆

    visibility=team, scope=project
    跨阶段/跨任务 replan 使用 project 级 scope，不编造 related IDs。
    """
    payload = proposal.payload
    if isinstance(payload, str):
        payload = json.loads(payload)
    output = ReplanOutput.model_validate(payload)

    project_name = resolve_project_name(session, project.id)
    source_hash = _compute_source_hash(_get_replan_confirmed_stable_fields(output))
    candidates: list[ProjectMemoryCandidate] = []

    # ── plan 记忆（始终创建）──
    plan_content = f"项目「{project_name}」的计划已调整：{output.impact}。"
    plan_rationale = f"重排理由：{output.reason}。来源：重排确认。"

    candidates.append(
        ProjectMemoryCandidate(
            memory_type="plan",
            scope="project",
            content=plan_content,
            rationale=plan_rationale,
            source_type="replan_confirmed",
            source_id=proposal.id,
            source_hash=source_hash,
            visibility="team",
        )
    )

    # ── tradeoff 记忆（至多 1 条，聚合）──
    if _has_tradeoff_rationale(output):
        adj_reasons = []
        for adj in output.stage_adjustments:
            if adj.reason.strip():
                stage_title = resolve_stage_title(session, adj.stage_id)
                adj_reasons.append(f"「{stage_title}」：{adj.reason.strip()}")
        tc_reasons = []
        for tc in output.task_changes:
            if tc.reason.strip():
                task_title = resolve_task_title(session, tc.task_id)
                tc_reasons.append(f"「{task_title}」：{tc.reason.strip()}")

        all_reasons = adj_reasons + tc_reasons
        if all_reasons:
            aggregated_cn = "；".join(sorted(all_reasons)) if len(all_reasons) > 1 else all_reasons[0]

            tradeoff_content = f"项目「{project_name}」的重排权衡：{aggregated_cn}。"
            tradeoff_rationale = "重排确认时团队对阶段和任务进行了调整。来源：重排确认。"

            candidates.append(
                ProjectMemoryCandidate(
                    memory_type="tradeoff",
                    scope="project",
                    content=tradeoff_content,
                    rationale=tradeoff_rationale,
                    source_type="replan_confirmed",
                    source_id=proposal.id,
                    source_hash=source_hash,
                    visibility="team",
                )
            )

    # ── boundary 记忆（至多 1 条）──
    if _has_boundary_rationale(output):
        boundary_changes = []
        for tc in output.task_changes:
            if tc.can_cut is not None or (tc.status and tc.status.value in ("cancelled", "blocked")):
                task_title = resolve_task_title(session, tc.task_id)
                boundary_changes.append(task_title)

        if boundary_changes:
            sorted_boundaries = sorted(set(boundary_changes))
            boundary_cn = "、".join(sorted_boundaries)

            boundary_content = f"项目「{project_name}」的范围调整：涉及「{boundary_cn}」等任务。"
            boundary_rationale = "重排确认时团队对任务范围和优先级进行了调整。来源：重排确认。"

            candidates.append(
                ProjectMemoryCandidate(
                    memory_type="boundary",
                    scope="project",
                    content=boundary_content,
                    rationale=boundary_rationale,
                    source_type="replan_confirmed",
                    source_id=proposal.id,
                    source_hash=source_hash,
                    visibility="team",
                )
            )

    return candidates


# ─── replan_rejected extractor ──────────────────────────────────────────────


def _get_replan_rejected_stable_fields(
    proposal: AgentProposal,
    rejection_reason: str,
) -> dict:
    """提取 replan rejection 中影响抽取语义的稳定字段。"""
    return {
        "proposal_type": proposal.proposal_type,
        "rejection_reason": rejection_reason,
    }


def extract_replan_rejected(
    session: Session,
    *,
    proposal: AgentProposal,
    project: Project,
) -> list[ProjectMemoryCandidate]:
    """replan_rejected → 1 条 rejection 记忆（仅当 rejection_reason 非空）。

    visibility=team, scope=project
    与 proposal_rejected 共享 rejection memory_type 但 source_type 区分。
    """
    rejection_reason = (proposal.rejection_reason or "").strip()
    if not rejection_reason:
        return []

    project_name = resolve_project_name(session, project.id)
    source_hash = _compute_source_hash(
        _get_replan_rejected_stable_fields(proposal, rejection_reason)
    )

    content = f"项目「{project_name}」的重排方案未被采纳。"
    rationale = f"拒绝理由：{rejection_reason}。来源：重排方案拒绝。"

    return [
        ProjectMemoryCandidate(
            memory_type="rejection",
            scope="project",
            content=content,
            rationale=rationale,
            source_type="replan_rejected",
            source_id=proposal.id,
            source_hash=source_hash,
            visibility="team",
        )
    ]
