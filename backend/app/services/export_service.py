from sqlmodel import Session, select

from app.models import (
    ActionCard,
    AgentEvent,
    AssignmentProposal,
    Project,
    ProjectResource,
    Risk,
    Stage,
    Task,
    User,
    Workspace,
)
from app.models.enums import AgentEventStatus, AgentEventType


def generate_review_summary(session: Session, project_id: str) -> str:
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError("Project not found")
    workspace = session.get(Workspace, project.workspace_id)
    if workspace is None:
        raise ValueError("Workspace not found")

    stages = list(
        session.exec(select(Stage).where(Stage.project_id == project_id).order_by(Stage.order_index)).all()
    )
    tasks = list(session.exec(select(Task).where(Task.project_id == project_id)).all())
    resources = list(session.exec(select(ProjectResource).where(ProjectResource.project_id == project_id)).all())
    proposals = list(
        session.exec(select(AssignmentProposal).where(AssignmentProposal.project_id == project_id)).all()
    )
    action_cards = list(session.exec(select(ActionCard).where(ActionCard.project_id == project_id)).all())
    risks = list(session.exec(select(Risk).where(Risk.project_id == project_id)).all())

    user_names = {
        user.id: user.display_name
        for user in session.exec(select(User)).all()
    }

    STATUS_LABELS = {
        "draft": "草稿",
        "active": "进行中",
        "at_risk": "有风险",
        "completed": "已完成",
        "pending": "待开始",
        "not_started": "未开始",
        "in_progress": "进行中",
        "done": "已完成",
        "blocked": "受阻",
        "open": "待处理",
        "accepted": "已接受",
        "ignored": "已忽略",
        "resolved": "已解决",
        "proposed": "待确认",
        "owner_confirmed": "已确认",
        "owner_rejected": "已拒绝",
        "negotiating": "协调中",
        "finalized": "已定稿",
    }

    SEVERITY_LABELS = {"high": "高危", "medium": "中危", "low": "低危"}

    def status_zh(val: str) -> str:
        return STATUS_LABELS.get(val, val)

    def severity_zh(val: str) -> str:
        return SEVERITY_LABELS.get(val, val)

    lines: list[str] = [
        "# ProjectFlow 评审摘要",
        "",
        f"## {project.name}",
        "",
        f"- 工作区：{workspace.name}",
        f"- 状态：{status_zh(project.status.value)}",
        f"- 截止日期：{project.deadline.isoformat()}",
        f"- 交付物：{project.deliverables}",
        "",
        "## 项目方向",
        "",
        project.idea,
        "",
    ]

    if resources:
        lines.extend(["## 相关资料", ""])
        for resource in resources:
            detail = resource.content_text or resource.url or resource.file_name or "无详情"
            lines.append(f"- {resource.title}：{detail}")
        lines.append("")

    lines.extend(["## 阶段计划", ""])
    for stage in stages:
        lines.append(
            f"- {stage.name}（{status_zh(stage.status.value)}，{stage.start_date.isoformat()} 至 {stage.end_date.isoformat()}）：{stage.goal}"
        )
    lines.append("")

    lines.extend(["## 任务分工", ""])
    for task in tasks:
        owner = user_names.get(task.owner_user_id or "", "未分配")
        backup = user_names.get(task.backup_owner_user_id or "", "无备选")
        lines.append(
            f"- [{task.priority.value}] {task.title} - {status_zh(task.status.value)}；负责人：{owner}；备选：{backup}；截止：{task.due_date.isoformat()}"
        )
        if task.assignment_reason:
            lines.append(f"  - 分配理由：{task.assignment_reason}")
    if not tasks:
        lines.append("- 暂无任务。")
    lines.append("")

    lines.extend(["## 分工提案", ""])
    for proposal in proposals:
        task = next((item for item in tasks if item.id == proposal.task_id), None)
        owner = user_names.get(proposal.recommended_owner_user_id, proposal.recommended_owner_user_id)
        lines.append(f"- {task.title if task else proposal.task_id}：{owner}（{status_zh(proposal.status.value)}）")
        lines.append(f"  - 理由：{proposal.reason}")
    if not proposals:
        lines.append("- 暂无分工提案。")
    lines.append("")

    lines.extend(["## 风险", ""])
    open_risks = [risk for risk in risks if risk.status.value == "open"]
    for risk in open_risks:
        lines.append(f"- {severity_zh(risk.severity.value)} {risk.title}：{risk.recommendation}")
    if not open_risks:
        lines.append("- 无待处理风险。")
    lines.append("")

    lines.extend(["## 下一步行动", ""])
    active_cards = [card for card in action_cards if card.status.value == "active"]
    for card in active_cards:
        assignee = user_names.get(card.user_id or "", "团队")
        lines.append(f"- {card.title}（{assignee}）：{card.content}")
        lines.append(f"  - 原因：{card.reason}")
    if not active_cards:
        lines.append("- 暂无活跃行动卡。")
    lines.append("")

    markdown = "\n".join(lines).strip() + "\n"
    event = AgentEvent(
        project_id=project.id,
        workspace_id=project.workspace_id,
        event_type=AgentEventType.export,
        status=AgentEventStatus.success,
        input_snapshot={"project_id": project.id},
        output_snapshot={
            "stages": len(stages),
            "tasks": len(tasks),
            "risks": len(open_risks),
            "action_cards": len(active_cards),
        },
        reasoning_summary="Generated a review summary from persisted project state.",
        user_confirmed=True,
    )
    session.add(event)
    session.commit()
    return markdown
