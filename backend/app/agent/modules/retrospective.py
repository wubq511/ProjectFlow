from app.agent.modules.common import AgentModuleRequest
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    project = workspace_state.project
    project_name = project.name if project else "项目"

    return AgentModuleRequest(
        event_type=AgentEventType.retrospective,
        user_prompt=(
            f"你是一个项目复盘专家。请对「{project_name}」进行深度复盘分析。\n\n"
            "请基于以下项目数据，生成一份有洞察力的项目复盘总结：\n"
            "1. 项目整体回顾：用叙事方式描述项目从启动到当前状态的历程\n"
            "2. 关键成就：列出项目中最重要的 3-5 个成果\n"
            "3. 挑战与应对：列出遇到的主要困难以及如何解决的\n"
            "4. 经验教训：基于项目过程总结 3-5 条可复用的经验\n"
            "5. 整体评价：对项目状态给出客观评价\n\n"
            "要求：\n"
            "- 所有文本必须用中文\n"
            "- 引用成员时用 display_name（如'小林'），不要用 ID\n"
            "- 引用任务时用 task title，不要用 ID\n"
            "- 分析要基于实际数据，不要编造\n"
            "- 语气要客观专业，像一个资深项目经理在做复盘"
        ),
        fallback_payload={
            "project_summary": f"「{project_name}」项目复盘总结：项目当前状态需要进一步分析。",
            "key_achievements": ["项目已启动并建立基本框架"],
            "challenges": ["需要更多数据来分析具体挑战"],
            "lessons_learned": ["定期复盘有助于发现问题"],
            "overall_assessment": "项目处于推进中，建议继续跟踪关键指标。",
            "reason": "回退方案：由于 Agent 输出不稳定，生成了基础复盘摘要。",
            "requires_confirmation": False,
        },
    )
