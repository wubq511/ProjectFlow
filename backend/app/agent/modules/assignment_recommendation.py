from app.agent.modules.common import (
    AgentModuleRequest,
    SKILL_NAME_CN_MAP,
    active_stage_id,
    assignable_tasks,
    rejected_assignment_pairs,
    score_member_for_task,
)
from app.models.enums import AgentEventType
from app.schemas.workspace_state import MemberState, TaskState, WorkspaceStateResponse


def _build_user_facing_assignment(
    task: TaskState,
    owner: MemberState,
    backup: MemberState | None,
    score: int,
    backup_score: int | None,
    is_single_member: bool,
    rejected: set[tuple[str, str]],
    risk_note_override: str | None = None,
) -> dict:
    """Build a single assignment fallback payload entry with Chinese user-facing text."""
    task_title = task.title
    owner_name = owner.display_name
    skill_names = [str(s) for s in owner.skills]
    skill_display = "、".join(skill_names[:3]) if skill_names else "未指定"

    # Reason
    if is_single_member:
        reason = (
            f"团队仅有一位成员 {owner_name}，所有任务需要由同一人承担。"
            f"建议负责人按优先级推进，必要时寻求外部支援或调整范围。"
        )
    else:
        match_parts = [f"{owner_name}的技能涉及{skill_display}"]
        if owner.available_hours_per_week >= task.estimated_hours:
            match_parts.append(f"可用时间 {owner.available_hours_per_week}h/周，满足任务预估 {task.estimated_hours}h")
        else:
            match_parts.append(f"可用时间 {owner.available_hours_per_week}h/周，但不足任务预估 {task.estimated_hours}h")
        if owner.role_preference or owner.interests:
            match_parts.append("偏好/兴趣与任务内容相关")
        reason = "；".join(match_parts) + f"，建议由 {owner_name} 承担「{task_title}」。"

    # Skill match
    if is_single_member:
        skill_match = f"成员拥有技能：{skill_display}" if skill_names else "成员暂无明确技能信息"
    else:
        skill_match = f"技能匹配：{skill_display}" if skill_names else "暂无明确技能匹配"

    # Availability match
    if is_single_member:
        availability_match = f"可用时间 {owner.available_hours_per_week}h/周"
    else:
        avail_detail = f"，预估需 {task.estimated_hours}h" if task.estimated_hours > 0 else ""
        availability_match = f"时间匹配：可用 {owner.available_hours_per_week}h/周{avail_detail}"

    # Preference match
    if is_single_member:
        preference_match = (
            f"偏好：{owner.role_preference}；兴趣：{owner.interests}"
            if owner.role_preference or owner.interests
            else "无明确偏好"
        )
    else:
        preference_match = f"偏好匹配：{owner.role_preference or '未指定'}；兴趣：{owner.interests or '未指定'}"

    # Constraint
    if is_single_member:
        constraint_respected = owner.constraints if owner.constraints else "无明显限制"
    else:
        constraint_respected = f"限制检查：{owner.constraints}" if owner.constraints else "限制检查：无明显冲突"

    # Risk note
    if risk_note_override:
        risk_note = risk_note_override
    elif is_single_member:
        risk_note = "单人团队无备选负责人，需关注工作量过载风险。建议合理安排优先级，必要时调整项目范围。"
    elif (task.id, owner.user_id) in rejected:
        risk_note = "非最优评分的成员被推荐，因更高分成员被该任务拒绝过，需人工确认。"
    else:
        risk_note = None

    return {
        "task_id": task.id,
        "recommended_owner_user_id": owner.user_id,
        "backup_owner_user_id": backup.user_id if backup else None,
        "reason": reason,
        "skill_match": skill_match,
        "availability_match": availability_match,
        "preference_match": preference_match,
        "constraint_respected": constraint_respected,
        "risk_note": risk_note,
    }


def build_request(workspace_state: WorkspaceStateResponse, *, stage_id: str | None = None) -> AgentModuleRequest:
    stage_id = stage_id or active_stage_id(workspace_state)
    tasks = assignable_tasks(workspace_state, stage_id=stage_id)
    members = workspace_state.members
    rejected = rejected_assignment_pairs(workspace_state)

    # No active stage or no eligible tasks
    if not stage_id or not tasks or not members:
        return AgentModuleRequest(
            event_type=AgentEventType.assign,
            user_prompt=(
                "Recommend owners for unassigned tasks in the current active stage only. "
                "Cover all eligible tasks. Use existing member IDs and task IDs. "
                "All user-facing text must be in Chinese."
            ),
            fallback_payload={
                "assignments": [],
                "requires_confirmation": True,
                "reason": "当前没有可分配的任务或成员，无需分工推荐。",
            },
        )

    is_single_member = len(members) == 1

    assignments: list[dict] = []
    assigned_counts: dict[str, int] = {m.user_id: 0 for m in members}

    for task in tasks:
        # Score all members for this task
        scored = []
        for member in members:
            # Skip if this (task, member) pair was already rejected
            if (task.id, member.user_id) in rejected:
                continue
            s = score_member_for_task(member, task, assigned_counts[member.user_id])
            scored.append((s, member))

        if not scored:
            # All members rejected this task before; pick highest-score member anyway
            scored = sorted(
                [(score_member_for_task(m, task, assigned_counts[m.user_id]), m) for m in members],
                key=lambda x: -x[0],
            )
            was_all_rejected = True
        else:
            scored.sort(key=lambda x: -x[0])
            was_all_rejected = False

        best_score, best_member = scored[0]

        # For multi-member: pick backup from remaining
        backup_member: MemberState | None = None
        backup_score: int | None = None
        if not is_single_member and len(scored) > 1:
            for s, m in scored[1:]:
                if m.user_id != best_member.user_id:
                    backup_member = m
                    backup_score = s
                    break
            # If no different-member backup, second-best could be same member with different combo
            if backup_member is None and len(members) > 1:
                alt = next((m for m in members if m.user_id != best_member.user_id), None)
                if alt:
                    backup_member = alt
                    backup_score = 0

        risk_override = None
        if was_all_rejected:
            risk_override = (
                f"所有候选人都曾被该任务拒绝过，建议人工确认 {best_member.display_name} 是否愿意承担「{task.title}」。"
            )
        elif is_single_member:
            risk_override = "单人团队无备选负责人，需关注工作量过载风险。"

        entry = _build_user_facing_assignment(
            task=task,
            owner=best_member,
            backup=backup_member,
            score=best_score,
            backup_score=backup_score,
            is_single_member=is_single_member,
            rejected=rejected,
            risk_note_override=risk_override,
        )
        assignments.append(entry)
        assigned_counts[best_member.user_id] = assigned_counts.get(best_member.user_id, 0) + 1

    requires_confirmation = True
    # Resolve stage name for user-facing reason
    stage_name = stage_id
    if workspace_state.project:
        stage = next((s for s in workspace_state.project.stages if s.id == stage_id), None)
        if stage:
            stage_name = stage.name
    reason = (
        f"为当前阶段「{stage_name}」的 {len(tasks)} 个任务生成了 {len(assignments)} 条分工建议。"
        if len(assignments) == len(tasks)
        else f"为当前阶段的 {len(tasks)} 个任务生成了 {len(assignments)} 条分工建议，部分任务因已拒绝组合暂未覆盖。"
    )

    # Build skill name guidance for LLM prompt
    skill_name_guide = "、".join(f"{cn}({eng})" for eng, cn in SKILL_NAME_CN_MAP.items())

    return AgentModuleRequest(
        event_type=AgentEventType.assign,
        user_prompt=(
            "Recommend owners for unassigned tasks in the current active stage only. "
            "Only generate assignments for tasks in the active stage that are not done, "
            "not already assigned (no owner_user_id), and not covered by existing proposals "
            "with status finalized, owner_confirmed, proposed, or negotiating. "
            "Avoid recommending the same (task_id, recommended_owner_user_id) pair that was "
            "owner_rejected before. "
            "Cover ALL eligible tasks — do not skip any. "
            "Each assignment must have owner, backup_owner (different from owner if possible), "
            "reason, skill_match, availability_match, preference_match, constraint_respected, risk_note. "
            "Use only existing member IDs and task IDs. "
            "All user-facing text must be in Chinese. "
            f"Skill names must use Chinese labels（{skill_name_guide}）. "
            "Do NOT use English underscore format like ai_ml, prompt_engineering in user-facing text. "
            "Backend will normalize stray English skill names as a safety net, "
            "but prefer Chinese labels directly."
        ),
        fallback_payload={
            "assignments": assignments,
            "requires_confirmation": requires_confirmation,
            "reason": reason,
        },
    )
