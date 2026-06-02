from datetime import date

from app.agent.modules.common import (
    AgentModuleRequest,
    project_deadline_or_today,
    project_name_or_default,
    stage_windows,
)
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    start = date.today()
    deadline = project_deadline_or_today(workspace_state)
    end = deadline if deadline >= start else start
    project_name = project_name_or_default(workspace_state)
    deliverables = workspace_state.project.deliverables if workspace_state.project else "可演示交付物"
    windows = stage_windows(start, end, preferred_count=3)
    stage_templates = [
        {
            "name": "方向收敛",
            "goal": f"确认{project_name}的最小演示闭环、核心用户和范围边界。",
            "deliverable": "已确认的方向卡和阶段目标",
            "done_criteria": ["方向卡已确认", "延期功能和必做功能已分开"],
            "reason": "先锁定目标和边界，避免任务拆解时范围继续发散。",
        },
        {
            "name": "核心实现",
            "goal": f"围绕“{deliverables}”完成最小可演示路径。",
            "deliverable": "可运行的核心流程",
            "done_criteria": ["核心路径可以从入口走到结果", "P0 任务有明确验收标准"],
            "reason": "中段优先完成能证明项目价值的主路径。",
        },
        {
            "name": "演示加固",
            "goal": "补齐演示数据、风险处理和展示说明，降低现场演示失败概率。",
            "deliverable": "稳定演示版本和演示检查清单",
            "done_criteria": ["演示数据可重置", "关键风险有应对动作", "展示脚本可复用"],
            "reason": "最后阶段聚焦稳定性和讲解材料，而不是继续扩展范围。",
        },
    ]
    stages = []
    for index, (window_start, window_end) in enumerate(windows):
        template = stage_templates[min(index, len(stage_templates) - 1)]
        stages.append({
            "name": template["name"],
            "goal": template["goal"],
            "start_date": window_start.isoformat(),
            "end_date": window_end.isoformat(),
            "deliverable": template["deliverable"],
            "done_criteria": template["done_criteria"],
            "order_index": index,
            "reason": template["reason"],
        })

    return AgentModuleRequest(
        event_type=AgentEventType.plan,
        user_prompt=(
            "Create a lean stage plan from today to the project deadline. "
            "Use 3 stages unless the deadline clearly requires fewer. "
            "Each reason must cite deadline, deliverables, member capacity, or existing progress."
        ),
        fallback_payload={
            "stages": stages,
            "reason": f"fallback 根据“{project_name}”的截止日期生成中文阶段计划，并保持在可确认范围内。",
        },
    )
