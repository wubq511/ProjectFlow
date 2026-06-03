from app.agent.modules.common import (
    AgentModuleRequest,
    first_member_id,
    first_task_id,
)
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    member_id = first_member_id(workspace_state)
    task_id = first_task_id(workspace_state)

    if member_id is None or task_id is None or workspace_state.project is None:
        return AgentModuleRequest(
            event_type=AgentEventType.negotiate,
            user_prompt="Propose assignment negotiation options after a member rejects an assignment.",
            fallback_payload={
                "from_user_id": "",
                "desired_task_id": "",
                "current_owner_user_id": "",
                "message": "当前没有可协商的成员或任务。",
                "options": ["等待人工协调"],
                "requires_confirmation": True,
                "reason": "无可协商的成员或任务。",
            },
        )

    project = workspace_state.project

    # Collect rejected proposals with their responses
    task_by_id = {t.id: t for t in project.tasks}
    member_by_id = {m.user_id: m for m in workspace_state.members}

    rejected_proposals = [
        p for p in project.assignment_proposals
        if p.status == "owner_rejected"
    ]
    pending_negotiations = [
        n for n in project.assignment_negotiations
        if n.status == "pending"
    ]

    # Build rejection context for prompt
    rejection_lines: list[str] = []
    for prop in rejected_proposals[-5:]:  # Last 5 rejected proposals max
        task = task_by_id.get(prop.task_id)
        member = member_by_id.get(prop.recommended_owner_user_id)
        task_title = task.title if task else prop.task_id
        member_name = member.display_name if member else prop.recommended_owner_user_id

        # Find the rejection response for this proposal
        reject_reason = ""
        preferred_task_id = ""
        for resp in project.assignment_responses:
            if resp.proposal_id == prop.id and resp.response == "reject":
                reject_reason = resp.reason or ""
                preferred_task_id = resp.preferred_task_id or ""
                break

        preferred_title = ""
        if preferred_task_id:
            preferred_task = task_by_id.get(preferred_task_id)
            preferred_title = preferred_task.title if preferred_task else preferred_task_id

        line = f"- {member_name} 拒绝了「{task_title}」"
        if reject_reason:
            line += f"（原因：{reject_reason}）"
        if preferred_title:
            line += f"，偏好任务：「{preferred_title}」"
        rejection_lines.append(line)

    # Build negotiation context
    negotiation_lines: list[str] = []
    for neg in pending_negotiations[-3:]:  # Last 3 pending negotiations
        from_member = member_by_id.get(neg.from_user_id)
        desired_task = task_by_id.get(neg.desired_task_id)
        current_owner = member_by_id.get(neg.current_owner_user_id) if neg.current_owner_user_id else None
        from_name = from_member.display_name if from_member else neg.from_user_id
        desired_title = desired_task.title if desired_task else neg.desired_task_id
        owner_name = current_owner.display_name if current_owner else "未分配"
        negotiation_lines.append(
            f"- {from_name} 希望换到「{desired_title}」（当前负责人：{owner_name}）"
        )

    # Build member summary
    member_summary = "\n".join(
        f"- {m.display_name}（{m.user_id}）：技能={'、'.join(str(s) for s in m.skills[:3]) if m.skills else '未指定'}，"
        f"可用 {m.available_hours_per_week}h/周，偏好 {m.role_preference or '未指定'}"
        for m in workspace_state.members
    )

    # Determine a sensible fallback: use the first rejected proposal's data
    fallback_from_user = member_id
    fallback_task = task_id
    # Look up actual task owner instead of defaulting to first member
    first_task_obj = task_by_id.get(task_id) if task_id else None
    fallback_current_owner = first_task_obj.owner_user_id if first_task_obj and first_task_obj.owner_user_id else None
    fallback_message = "请确认团队成员是否同意此次任务交换。"
    fallback_options = ["维持当前分工", "接受交换提议"]

    if rejected_proposals:
        first_rejected = rejected_proposals[0]
        fallback_from_user = first_rejected.recommended_owner_user_id
        fallback_task = first_rejected.task_id
        # Find preferred task from response
        for resp in project.assignment_responses:
            if resp.proposal_id == first_rejected.id and resp.preferred_task_id:
                fallback_task = resp.preferred_task_id
                break
        # Find current owner from proposal or task
        task = task_by_id.get(fallback_task)
        fallback_current_owner = task.owner_user_id if task and task.owner_user_id else None

        rejected_member = member_by_id.get(first_rejected.recommended_owner_user_id)
        rejected_task = task_by_id.get(first_rejected.task_id)
        desired_task = task_by_id.get(fallback_task)
        rejected_name = rejected_member.display_name if rejected_member else "成员"
        rejected_title = rejected_task.title if rejected_task else "原任务"
        desired_title = desired_task.title if desired_task else "偏好任务"
        fallback_message = (
            f"{rejected_name} 拒绝了「{rejected_title}」并希望改为「{desired_title}」。"
            f"请团队成员讨论是否接受此交换。"
        )
        fallback_options = [
            f"将「{desired_title}」分配给 {rejected_name}",
            f"{rejected_name} 继续承担「{rejected_title}」",
            "重新运行分工推荐",
        ]

    rejection_context = "\n".join(rejection_lines) if rejection_lines else "暂无拒绝记录"
    negotiation_context = "\n".join(negotiation_lines) if negotiation_lines else "暂无进行中的协商"

    prompt = (
        "根据以下团队成员分工拒绝和协商情况，生成协商建议。\n\n"
        f"## 团队成员\n{member_summary}\n\n"
        f"## 被拒绝的分工\n{rejection_context}\n\n"
        f"## 进行中的协商\n{negotiation_context}\n\n"
        "请基于以上信息生成协商方案：\n"
        "- from_user_id：发起协商的成员 ID（拒绝分工的成员）\n"
        "- desired_task_id：该成员希望承担的任务 ID\n"
        "- current_owner_user_id：该任务当前的负责人 ID（如未分配则为 null）\n"
        "- message：用中文向团队说明协商原因和建议，引用实际成员名和任务名\n"
        "- options：2-3 个具体的中文协商选项，每个选项包含实际成员名和任务名\n\n"
        "注意：\n"
        "- 所有用户可见文本必须使用中文\n"
        "- 成员和任务名称必须来自上方列表，不能编造\n"
        "- options 中每个选项必须用成员 display_name 和任务 title，不得使用 user_id/task_id\n"
        "- 协商建议应基于被拒绝的具体情况，推荐合理的交换方案"
    )

    return AgentModuleRequest(
        event_type=AgentEventType.negotiate,
        user_prompt=prompt,
        fallback_payload={
            "from_user_id": fallback_from_user,
            "desired_task_id": fallback_task,
            "current_owner_user_id": fallback_current_owner,
            "message": fallback_message,
            "options": fallback_options,
            "requires_confirmation": True,
            "reason": "基于工作区中实际拒绝记录和协商状态生成的 fallback 协商方案。",
        },
    )
