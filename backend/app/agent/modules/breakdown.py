from app.agent.modules.common import (
    AgentModuleRequest,
    first_stage_id,
    first_stage_name_or_default,
    project_deadline_or_today,
    project_name_or_default,
)
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    stage_id = first_stage_id(workspace_state) or ""
    stage_name = first_stage_name_or_default(workspace_state)
    project_name = project_name_or_default(workspace_state)
    due_date = project_deadline_or_today(workspace_state).isoformat()
    return AgentModuleRequest(
        event_type=AgentEventType.breakdown,
        user_prompt=(
            "Break the current or first stage into exactly 3 prioritized tasks. "
            "Use existing stage_id, P0/P1/P2 priorities, realistic hours, real dependencies only, and due dates before the stage/project deadline. "
            "Each reason must cite stage goal, member skills, or deadline."
        ),
        fallback_payload={
            "tasks": [
                {
                    "stage_id": stage_id,
                    "title": "确认阶段验收标准",
                    "description": f"围绕“{stage_name}”明确本阶段必须交付的最小成果、验收方式和可推迟内容。",
                    "priority": "P0",
                    "due_date": due_date,
                    "estimated_hours": 1.5,
                    "dependency_ids": [],
                    "acceptance_criteria": ["验收标准可被团队成员直接判断", "至少列出 1 项可推迟范围"],
                    "can_cut": False,
                    "reason": "P0 先保证阶段目标清晰，避免后续任务偏离演示闭环。",
                },
                {
                    "stage_id": stage_id,
                    "title": "完成核心演示路径",
                    "description": f"实现或整理“{project_name}”当前阶段最小可演示路径，确保从入口到结果可以连贯展示。",
                    "priority": "P1",
                    "due_date": due_date,
                    "estimated_hours": 4,
                    "dependency_ids": [],
                    "acceptance_criteria": ["核心路径可以被手动走通", "关键页面或接口有明确输出"],
                    "can_cut": False,
                    "reason": "P1 聚焦能证明项目价值的核心交付物。",
                },
                {
                    "stage_id": stage_id,
                    "title": "准备演示说明和风险清单",
                    "description": "整理演示脚本、已知风险和应对动作，让团队能稳定复现本阶段成果。",
                    "priority": "P2",
                    "due_date": due_date,
                    "estimated_hours": 2,
                    "dependency_ids": [],
                    "acceptance_criteria": ["演示说明可读", "至少列出 2 个风险和应对动作"],
                    "can_cut": True,
                    "reason": "P2 提升展示质量，但时间不足时可以压缩。",
                },
            ],
            "reason": f"fallback 为“{project_name}”生成 3 个中文任务，覆盖标准确认、核心实现和展示准备。",
        },
    )
