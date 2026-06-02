from app.agent.modules.common import (
    AgentModuleRequest,
    project_idea_or_default,
    project_name_or_default,
)
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    project_name = project_name_or_default(workspace_state)
    project_idea = project_idea_or_default(workspace_state)
    return AgentModuleRequest(
        event_type=AgentEventType.clarify,
        user_prompt=(
            "Create a concise direction card from WorkspaceState. "
            "Use project idea, deadline, deliverables, member skills/hours, and constraints. "
            "Return only high-value risks/questions that affect the next plan."
        ),
        fallback_payload={
            "problem": f"{project_name}需要先把用户场景、核心闭环和演示边界收敛清楚，避免团队直接进入发散实现。",
            "users": "以当前 Workspace 中的学生项目成员和项目评审观察者为主要使用者。",
            "value": "把模糊想法整理成可确认的方向卡，让后续阶段计划和任务拆解有稳定依据。",
            "deliverables": [
                "一张已确认的项目方向卡",
                "一组可用于阶段规划的交付边界",
            ],
            "boundaries": [
                "只使用 WorkspaceState 中已有的项目、成员和资源信息",
                "不编造未出现的成员、任务或外部集成",
            ],
            "risks": [
                "如果不先确认边界，后续阶段计划容易过大",
                "如果交付物不清晰，任务优先级会失真",
            ],
            "suggested_questions": [
                "这次演示必须证明的最小闭环是什么？",
                "哪些功能可以明确推迟到下一轮？",
            ],
            "reason": f"基于项目“{project_name}”的输入“{project_idea}”，fallback 只给出安全的中文基线，等待用户确认。",
        },
    )
