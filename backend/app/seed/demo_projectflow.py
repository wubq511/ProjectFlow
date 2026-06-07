"""Demo seed data for ProjectFlow MVP.

Creates a realistic 5-6 member student team with full project data
sufficient for the demo path: workspace, members, project, stages,
tasks, assignments, check-ins, risks, and action cards.
"""

import json
from datetime import datetime, timezone

from sqlmodel import Session

from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMembership
from app.models.invitation import Invitation
from app.models.member_profile import MemberProfile
from app.models.project import Project
from app.models.resource import ProjectResource
from app.models.stage import Stage
from app.models.task import Task
from app.models.assignment import AssignmentProposal
from app.models.checkin import CheckInCycle, CheckInResponse
from app.models.risk import Risk
from app.models.action_card import ActionCard
from app.models.timeline import AgentEvent


# Fixed IDs for deterministic demo data
USER_IDS = {
    "xiaolin": "demo-user-001",
    "xiaowang": "demo-user-002",
    "xiaozhang": "demo-user-003",
    "xiaoli": "demo-user-004",
    "xiaozhao": "demo-user-005",
    "xiaoliu": "demo-user-006",
}

WORKSPACE_ID = "demo-workspace-001"
PROJECT_ID = "demo-project-001"

STAGE_IDS = {
    "research": "demo-stage-001",
    "design": "demo-stage-002",
    "implementation": "demo-stage-003",
    "testing": "demo-stage-004",
}

TASK_IDS = {
    "user_research": "demo-task-001",
    "competitor_analysis": "demo-task-002",
    "direction_card": "demo-task-003",
    "ui_design": "demo-task-004",
    "api_design": "demo-task-005",
    "frontend_shell": "demo-task-006",
    "backend_api": "demo-task-007",
    "agent_core": "demo-task-008",
    "integration_test": "demo-task-009",
    "demo_polish": "demo-task-010",
}

PROPOSAL_IDS = {
    "frontend_shell": "demo-proposal-006",
    "backend_api": "demo-proposal-007",
    "agent_core": "demo-proposal-008",
}

CHECKIN_CYCLE_ID = "demo-checkin-cycle-001"


def seed_demo_data(session: Session) -> dict:
    """Load demo seed data into the database. Returns a summary of created entities."""

    now = datetime.now(timezone.utc)

    # -- Users --
    users = {}
    user_defs = [
        ("xiaolin", "小林", "xiaolin@example.com"),
        ("xiaowang", "小王", "xiaowang@example.com"),
        ("xiaozhang", "小张", "xiaozhang@example.com"),
        ("xiaoli", "小李", "xiaoli@example.com"),
        ("xiaozhao", "小赵", "xiaozhao@example.com"),
        ("xiaoliu", "小刘", "xiaoliu@example.com"),
    ]
    for key, name, email in user_defs:
        user = User(id=USER_IDS[key], display_name=name, email=email, created_at=now)
        session.add(user)
        users[key] = user

    # -- Workspace --
    workspace = Workspace(
        id=WORKSPACE_ID,
        name="ProjectFlow 团队",
        owner_user_id=USER_IDS["xiaolin"],
        description="AI Agent 工程训练营项目小队",
        created_at=now,
        updated_at=now,
    )
    session.add(workspace)

    # -- Memberships --
    for i, key in enumerate(USER_IDS):
        membership = WorkspaceMembership(
            id=f"demo-membership-{i+1:03d}",
            workspace_id=WORKSPACE_ID,
            user_id=USER_IDS[key],
            role="owner" if key == "xiaolin" else "member",
            joined_at=now,
        )
        session.add(membership)

    # -- Invitations (all accepted) --
    for i, key in enumerate(["xiaowang", "xiaozhang", "xiaoli", "xiaozhao", "xiaoliu"]):
        inv = Invitation(
            id=f"demo-inv-{i+1:03d}",
            workspace_id=WORKSPACE_ID,
            invited_name=users[key].display_name,
            invited_email=users[key].email,
            token=f"demo-token-{key}",
            status="accepted",
            created_at=now,
            accepted_at=now,
        )
        session.add(inv)

    # -- Member Profiles --
    profiles = [
        MemberProfile(
            id="demo-profile-001",
            user_id=USER_IDS["xiaolin"],
            workspace_id=WORKSPACE_ID,
            skills=json.dumps([
                {"name": "backend", "level": 4},
                {"name": "frontend", "level": 3},
                {"name": "project_management", "level": 4},
            ]),
            available_hours_per_week=12,
            role_preference="项目负责人 / 后端",
            interests="项目推进、系统设计、AI Agent 应用",
            constraints="工作日晚上和周末可用",
            collaboration_preference="喜欢先对齐方向再动手",
            created_at=now,
            updated_at=now,
        ),
        MemberProfile(
            id="demo-profile-002",
            user_id=USER_IDS["xiaowang"],
            workspace_id=WORKSPACE_ID,
            skills=json.dumps([
                {"name": "frontend", "level": 4},
                {"name": "design", "level": 3},
                {"name": "animation", "level": 3},
            ]),
            available_hours_per_week=10,
            role_preference="前端 / UI",
            interests="交互设计、动画效果、用户体验",
            constraints="周三晚上有课",
            created_at=now,
            updated_at=now,
        ),
        MemberProfile(
            id="demo-profile-003",
            user_id=USER_IDS["xiaozhang"],
            workspace_id=WORKSPACE_ID,
            skills=json.dumps([
                {"name": "backend", "level": 4},
                {"name": "database", "level": 3},
                {"name": "devops", "level": 2},
            ]),
            available_hours_per_week=8,
            role_preference="后端 / 数据",
            interests="API 设计、数据建模、自动化",
            constraints="周末经常回家",
            created_at=now,
            updated_at=now,
        ),
        MemberProfile(
            id="demo-profile-004",
            user_id=USER_IDS["xiaoli"],
            workspace_id=WORKSPACE_ID,
            skills=json.dumps([
                {"name": "frontend", "level": 3},
                {"name": "testing", "level": 4},
                {"name": "documentation", "level": 3},
            ]),
            available_hours_per_week=10,
            role_preference="测试 / 文档",
            interests="质量保障、用户文档、可演示性",
            constraints="周四下午有实验课",
            created_at=now,
            updated_at=now,
        ),
        MemberProfile(
            id="demo-profile-005",
            user_id=USER_IDS["xiaozhao"],
            workspace_id=WORKSPACE_ID,
            skills=json.dumps([
                {"name": "ai_ml", "level": 4},
                {"name": "backend", "level": 3},
                {"name": "prompt_engineering", "level": 4},
            ]),
            available_hours_per_week=8,
            role_preference="AI / Agent",
            interests="LLM 应用、Prompt 工程、Agent 编排",
            constraints="晚上 10 点后不在线",
            created_at=now,
            updated_at=now,
        ),
        MemberProfile(
            id="demo-profile-006",
            user_id=USER_IDS["xiaoliu"],
            workspace_id=WORKSPACE_ID,
            skills=json.dumps([
                {"name": "design", "level": 4},
                {"name": "frontend", "level": 2},
                {"name": "presentation", "level": 4},
            ]),
            available_hours_per_week=6,
            role_preference="设计 / 演示",
            interests="视觉设计、Demo 打磨、汇报展示",
            constraints="时间较少，优先做关键视觉和演示",
            created_at=now,
            updated_at=now,
        ),
    ]
    for p in profiles:
        session.add(p)

    # -- Project --
    direction_card = json.dumps({
        "problem": "大学生项目小队缺乏持续的项目推进和风险感知能力",
        "users": "大学生项目小队（3-8人）",
        "value": "AI Agent 主动推进项目，持续回答下一步做什么、谁适合做、哪些有风险",
        "deliverables": ["MVP demo", "README", "demo video", "review summary"],
        "boundaries": ["6周时间", "本地演示优先", "单 workspace", "不做多团队支持", "不做正式认证", "不做生产部署"],
        "risks": ["Agent 输出不稳定", "前后端联调困难", "演示翻车"],
        "suggested_questions": [
            "Demo 第一优先展示哪个主动推进场景？",
            "如果真实 LLM 超时，演示时采用哪个降级路径？",
        ],
        "source_summary": "基于团队成员调研（用户访谈 + 竞品分析）和项目想法输入，结合 6 周时间约束和 AI Agent 训练营交付要求",
        "assumptions": [
            "团队成员每周可投入 8-10 小时",
            "使用 mock LLM 可以跑通完整 demo 流程",
            "SQLite 在本地演示场景下性能够用",
            "评审关注产品完整性和 Agent 主动推进能力",
        ],
        "unknowns": [
            "真实 LLM 在 Agent 多步编排下的稳定性",
            "前后端联调阶段可能出现的字段不一致问题",
            "评审时是否允许现场演示还是需要录屏兜底",
        ],
        "mvp_boundary": {
            "must_have": ["方向澄清 → 阶段计划 → 任务拆解 → 分工推荐 → 主动推进 → 风险识别 → 动态重排"],
            "defer": ["多团队 workspace", "正式认证和权限系统", "外部集成（飞书/GitHub）"],
            "out_of_scope": ["移动端适配", "企业级部署", "多 Agent 架构", "文件解析"],
        },
        "decision_points": [
            "演示时使用 mock LLM 还是真实 LLM？",
            "是否需要支持成员在线实时协作还是异步即可？",
            "评审导出格式用 Markdown 还是 PDF？",
        ],
        "reason": "基于调研结果和项目约束，方向聚焦在'主动推进型 Agent'而非通用看板，核心差异在于状态变化后的主动判断和推进建议",
    }, ensure_ascii=False)

    project = Project(
        id=PROJECT_ID,
        workspace_id=WORKSPACE_ID,
        name="ProjectFlow",
        idea="帮助大学生项目小队推进项目的 AI Agent，不只是记录任务，而是持续回答：项目该往哪走？下一步做什么？谁适合做什么？哪些有风险？",
        deadline="2026-06-09",
        deliverables="MVP demo, README, demo video, review summary",
        status="active",
        current_stage_id=STAGE_IDS["implementation"],
        direction_card=direction_card,
        created_by=USER_IDS["xiaolin"],
        created_at=now,
        updated_at=now,
    )
    session.add(project)

    # -- Project Resources --
    resources = [
        ProjectResource(
            id="demo-resource-001",
            project_id=PROJECT_ID,
            type="text_note",
            title="训练营项目要求",
            content_text="6周内完成一个 AI Agent 产品 MVP，需要包含：主动推进能力、分工推荐、风险识别、动态重排、可演示 Demo。评审关注产品完整性和 Agent 能力。",
            created_at=now,
        ),
        ProjectResource(
            id="demo-resource-002",
            project_id=PROJECT_ID,
            type="link",
            title="shadcn/ui 组件库",
            url="https://ui.shadcn.com/",
            created_at=now,
        ),
        ProjectResource(
            id="demo-resource-003",
            project_id=PROJECT_ID,
            type="text_note",
            title="技术栈决策",
            content_text="Next.js + FastAPI + SQLite + 单 Coordinator Agent + 状态机控制流程。Agent 只在指定节点生成建议，确定性代码负责状态迁移。",
            created_at=now,
        ),
    ]
    for r in resources:
        session.add(r)

    # -- Stages --
    stages = [
        Stage(
            id=STAGE_IDS["research"],
            project_id=PROJECT_ID,
            name="调研与方向",
            goal="明确项目方向、目标用户和核心价值",
            start_date="2026-05-19",
            end_date="2026-05-25",
            deliverable="方向卡、竞品分析报告",
            done_criteria=json.dumps(["方向卡已确认", "竞品分析完成", "目标用户明确"]),
            status="completed",
            order_index=0,
        ),
        Stage(
            id=STAGE_IDS["design"],
            project_id=PROJECT_ID,
            name="设计与规划",
            goal="完成技术设计和阶段计划",
            start_date="2026-05-26",
            end_date="2026-05-31",
            deliverable="技术设计文档、API 契约、阶段计划",
            done_criteria=json.dumps(["技术设计完成", "API 契约对齐", "阶段计划确认"]),
            status="completed",
            order_index=1,
        ),
        Stage(
            id=STAGE_IDS["implementation"],
            project_id=PROJECT_ID,
            name="核心实现",
            goal="实现 Agent 核心流程和关键 UI",
            start_date="2026-06-01",
            end_date="2026-06-07",
            deliverable="Agent 核心闭环、关键页面、分工推荐",
            done_criteria=json.dumps(["Agent 核心流程跑通", "分工推荐可用", "关键页面完成"]),
            status="active",
            order_index=2,
        ),
        Stage(
            id=STAGE_IDS["testing"],
            project_id=PROJECT_ID,
            name="测试与打磨",
            goal="确保 Demo 稳定可演示",
            start_date="2026-06-07",
            end_date="2026-06-09",
            deliverable="稳定 Demo、演示脚本、评审摘要",
            done_criteria=json.dumps(["Demo 5分钟跑通", "无崩溃", "评审摘要导出"]),
            status="pending",
            order_index=3,
        ),
    ]
    for s in stages:
        session.add(s)

    # -- Tasks --
    tasks = [
        Task(
            id=TASK_IDS["user_research"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["research"],
            title="用户调研",
            description="调研大学生项目小队的痛点，访谈 3-5 个团队",
            priority="P0",
            status="done",
            owner_user_id=USER_IDS["xiaolin"],
            backup_owner_user_id=USER_IDS["xiaoliu"],
            assignment_reason="小林是项目负责人，沟通能力强，适合做用户访谈；小刘作为备选可协助整理访谈记录",
            due_date="2026-05-22",
            estimated_hours=6,
            acceptance_criteria=json.dumps(["访谈记录", "痛点总结"]),
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["competitor_analysis"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["research"],
            title="竞品分析",
            description="分析 Notion、Linear、飞书项目等工具的不足",
            priority="P1",
            status="done",
            owner_user_id=USER_IDS["xiaoliu"],
            backup_owner_user_id=USER_IDS["xiaowang"],
            assignment_reason="小刘设计技能 3 级，擅长产品分析；小王有前端设计经验可作为备选",
            due_date="2026-05-23",
            estimated_hours=4,
            acceptance_criteria=json.dumps(["竞品对比表", "差异化分析"]),
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["direction_card"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["research"],
            title="方向卡生成",
            description="基于调研结果生成项目方向卡",
            priority="P0",
            status="done",
            owner_user_id=USER_IDS["xiaolin"],
            backup_owner_user_id=USER_IDS["xiaozhao"],
            assignment_reason="小林掌握项目全局，适合收敛方向；小赵 AI/ML 技能 4 级可辅助 Agent 方向判断",
            due_date="2026-05-25",
            estimated_hours=3,
            acceptance_criteria=json.dumps(["方向卡确认", "目标用户明确"]),
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["ui_design"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["design"],
            title="UI 设计与组件规划",
            description="设计核心页面布局和组件体系",
            priority="P0",
            status="done",
            owner_user_id=USER_IDS["xiaowang"],
            backup_owner_user_id=USER_IDS["xiaoliu"],
            assignment_reason="小王前端技能 4 级、设计技能 3 级，意向为前端/UI；小刘设计技能 3 级可协助",
            due_date="2026-05-28",
            estimated_hours=8,
            acceptance_criteria=json.dumps(["核心页面线框图", "组件列表"]),
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["api_design"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["design"],
            title="API 契约设计",
            description="定义前后端 API 接口和数据模型",
            priority="P0",
            status="done",
            owner_user_id=USER_IDS["xiaozhang"],
            backup_owner_user_id=USER_IDS["xiaoli"],
            assignment_reason="小张后端技能 4 级、数据库技能 3 级，意向为后端/数据；小李全栈技能可作为备选",
            due_date="2026-05-29",
            estimated_hours=6,
            acceptance_criteria=json.dumps(["API 文档", "Schema 定义"]),
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["frontend_shell"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            title="前端 Shell 与核心页面",
            description="实现 App Shell、Onboarding、Workspace、Project Dashboard",
            priority="P0",
            status="in_progress",
            owner_user_id=USER_IDS["xiaowang"],
            backup_owner_user_id=USER_IDS["xiaoliu"],
            assignment_reason="小王前端技能 4 级，意向为前端/UI，每周 10 小时可用；小刘设计技能 3 级可协助 UI 打磨",
            due_date="2026-06-03",
            estimated_hours=12,
            acceptance_criteria=json.dumps(["App Shell 完成", "核心页面可交互"]),
            can_cut=False,
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["backend_api"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            title="后端 API 与数据模型",
            description="实现核心 API 端点和数据库操作",
            priority="P0",
            status="in_progress",
            owner_user_id=USER_IDS["xiaozhang"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            assignment_reason="小张后端技能 4 级、数据库技能 3 级，意向为后端/数据；小林后端技能 4 级可协助排查复杂问题",
            due_date="2026-06-03",
            estimated_hours=10,
            acceptance_criteria=json.dumps(["核心 API 可调用", "数据库 CRUD 正常"]),
            can_cut=False,
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["agent_core"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            title="Agent 核心流程",
            description="实现 Coordinator Agent、Clarification、Planning、Breakdown 模块",
            priority="P0",
            status="in_progress",
            owner_user_id=USER_IDS["xiaozhao"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            assignment_reason="小赵 AI/ML 技能 4 级、Prompt 工程 4 级，意向为 AI/Agent；小林全栈能力可协助调试",
            due_date="2026-06-05",
            estimated_hours=14,
            acceptance_criteria=json.dumps(["Agent 可生成方向卡", "可生成阶段计划", "可拆解任务"]),
            can_cut=False,
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["integration_test"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["testing"],
            title="集成测试与 Demo 验证",
            description="端到端测试核心流程，确保 Demo 稳定",
            priority="P0",
            status="not_started",
            owner_user_id=USER_IDS["xiaoli"],
            backup_owner_user_id=USER_IDS["xiaozhao"],
            assignment_reason="小李全栈技能均衡，适合做端到端测试；小赵熟悉 Agent 流程可协助验证",
            due_date="2026-06-08",
            estimated_hours=8,
            acceptance_criteria=json.dumps(["核心流程测试通过", "Demo 无崩溃"]),
            created_by_agent=True,
            updated_at=now,
        ),
        Task(
            id=TASK_IDS["demo_polish"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["testing"],
            title="Demo 打磨与演示脚本",
            description="打磨 UI、添加动画、编写演示脚本",
            priority="P1",
            status="not_started",
            owner_user_id=USER_IDS["xiaoliu"],
            backup_owner_user_id=USER_IDS["xiaowang"],
            assignment_reason="小刘设计技能 3 级，擅长产品展示；小王前端技能 4 级可协助动画和交互打磨",
            due_date="2026-06-09",
            estimated_hours=6,
            acceptance_criteria=json.dumps(["5分钟 Demo 跑通", "演示脚本完成"]),
            can_cut=True,
            created_by_agent=True,
            updated_at=now,
        ),
    ]
    for t in tasks:
        session.add(t)

    # -- Assignment Proposals (for active stage) --
    proposals = [
        AssignmentProposal(
            id=PROPOSAL_IDS["frontend_shell"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            task_id=TASK_IDS["frontend_shell"],
            recommended_owner_user_id=USER_IDS["xiaowang"],
            backup_owner_user_id=USER_IDS["xiaoliu"],
            reason="小王前端技能 4 级，设计技能 3 级，且意向为前端/UI，每周 10 小时可用",
            risk_note="小王周三晚上有课，可能影响进度",
            status="finalized",
            created_by_agent=True,
            created_at=now,
        ),
        AssignmentProposal(
            id=PROPOSAL_IDS["backend_api"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            task_id=TASK_IDS["backend_api"],
            recommended_owner_user_id=USER_IDS["xiaozhang"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            reason="小张后端技能 4 级，数据库技能 3 级，意向为后端/数据",
            risk_note="小张周末经常回家，可用时间偏少",
            status="finalized",
            created_by_agent=True,
            created_at=now,
        ),
        AssignmentProposal(
            id=PROPOSAL_IDS["agent_core"],
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            task_id=TASK_IDS["agent_core"],
            recommended_owner_user_id=USER_IDS["xiaozhao"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            reason="小赵 AI/ML 技能 4 级，Prompt 工程 4 级，意向为 AI/Agent",
            risk_note="小赵晚上 10 点后不在线，Agent 调试可能需要晚间时间",
            status="finalized",
            created_by_agent=True,
            created_at=now,
        ),
    ]
    for p in proposals:
        session.add(p)

    # -- Check-in Cycle --
    checkin_cycle = CheckInCycle(
        id=CHECKIN_CYCLE_ID,
        project_id=PROJECT_ID,
        stage_id=STAGE_IDS["implementation"],
        cadence_days=2,
        start_date="2026-06-01",
        next_due_date="2026-06-03",
        status="active",
        created_by_user_id=USER_IDS["xiaolin"],
        created_at=now,
    )
    session.add(checkin_cycle)

    # -- Check-in Responses (one with blocker) --
    checkin_responses = [
        CheckInResponse(
            id="demo-checkin-resp-001",
            cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaowang"],
            task_id=TASK_IDS["frontend_shell"],
            what_done="完成了 App Shell 和导航组件",
            blocker=None,
            available_hours_next_cycle=10,
            mood_or_confidence="high",
            created_at=now,
        ),
        CheckInResponse(
            id="demo-checkin-resp-002",
            cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaozhang"],
            task_id=TASK_IDS["backend_api"],
            what_done="完成了 User 和 Workspace 的 CRUD API",
            blocker="SQLite 外键约束报错，还在排查",
            available_hours_next_cycle=6,
            mood_or_confidence="medium",
            created_at=now,
        ),
        CheckInResponse(
            id="demo-checkin-resp-003",
            cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaozhao"],
            task_id=TASK_IDS["agent_core"],
            what_done="完成了 LLM client 和 Coordinator 骨架",
            blocker=None,
            available_hours_next_cycle=8,
            mood_or_confidence="high",
            created_at=now,
        ),
    ]
    for cr in checkin_responses:
        session.add(cr)

    # -- Risks --
    risks = [
        Risk(
            id="demo-risk-001",
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            task_id=TASK_IDS["backend_api"],
            type="dependency",
            severity="medium",
            title="后端 API 外键约束问题",
            description="小张报告 SQLite 外键约束报错，可能影响后端 API 进度",
            evidence=json.dumps([
                "小张 check-in 报告 blocker: SQLite 外键约束报错",
                "后端 API 是 P0 任务，阻塞前端联调",
            ]),
            recommendation="小林协助排查外键问题；如果 1 天内无法解决，考虑简化数据模型",
            status="open",
            created_by_agent=True,
            created_at=now,
        ),
        Risk(
            id="demo-risk-002",
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            type="workload",
            severity="high",
            title="小张可用时间下降",
            description="小张下周期可用时间从 8 小时降至 6 小时，后端 API 可能延期",
            evidence=json.dumps([
                "小张 check-in 报告 available_hours_next_cycle: 6",
                "小张 profile: available_hours_per_week: 8",
                "小张周末经常回家",
            ]),
            recommendation="考虑将部分后端工作分配给小林（后端技能 4 级），或削减非核心 API",
            status="open",
            created_by_agent=True,
            created_at=now,
        ),
        Risk(
            id="demo-risk-003",
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            type="deadline",
            severity="medium",
            title="核心实现阶段时间紧张",
            description="当前阶段 6 月 1 日至 7 日，3 个 P0 任务并行，任一延期将影响 Demo",
            evidence=json.dumps([
                "3 个 P0 任务同时 in_progress",
                "阶段截止 2026-06-07，剩余约 8 天",
                "Agent 核心预估 14 小时，是最大任务",
            ]),
            recommendation="优先保证 Agent 核心流程闭环，非核心功能可标记 can_cut",
            status="open",
            created_by_agent=True,
            created_at=now,
        ),
    ]
    for r in risks:
        session.add(r)

    # -- Action Cards --
    action_cards = [
        ActionCard(
            id="demo-action-001",
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaowang"],
            task_id=TASK_IDS["frontend_shell"],
            type="personal_task",
            title="继续前端 Shell 开发",
            content="完成 Onboarding 流程和 Workspace Dashboard 页面",
            reason="你的前端 Shell 任务正在进行中，check-in 显示进展顺利",
            goal="完成前端 Shell 和核心页面的可用闭环",
            start_suggestion="先检查 Onboarding、Workspace Dashboard 和 Project Dashboard 的加载态与空态",
            completion_standard="核心页面可进入、可刷新、可展示真实 API 数据且无页面崩溃",
            due_date="2026-06-03",
            status="active",
            created_by_agent=True,
            created_at=now,
        ),
        ActionCard(
            id="demo-action-002",
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaozhang"],
            task_id=TASK_IDS["backend_api"],
            type="personal_task",
            title="解决 SQLite 外键约束问题",
            content="排查外键约束报错原因，修复后继续实现 Assignment 和 CheckIn API",
            reason="你的 check-in 报告了 blocker，这是 P0 任务的关键阻塞",
            goal="解除后端 API 阻塞，恢复前后端联调",
            start_suggestion="复现外键约束报错并定位失败接口、模型关系和写入事务",
            completion_standard="Assignment、Check-in 和任务状态 API 可被前端调用且 smoke test 通过",
            due_date="2026-06-02",
            status="active",
            created_by_agent=True,
            created_at=now,
        ),
        ActionCard(
            id="demo-action-003",
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaolin"],
            type="risk_action",
            title="协助小张排查外键问题",
            content="小张报告后端外键约束报错，你的后端技能 4 级可以协助",
            reason="后端 API 是 P0 任务且阻塞前端联调，需要尽快解决",
            goal="在 1 天内降低后端阻塞风险",
            start_suggestion="和小张一起看外键约束报错堆栈，确认是否是数据模型或写入顺序问题",
            completion_standard="给出修复方案或明确可接受的简化数据模型方案",
            due_date="2026-06-02",
            status="active",
            created_by_agent=True,
            created_at=now,
        ),
        ActionCard(
            id="demo-action-004",
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            type="team_next_step",
            title="前后端联调准备",
            content="后端 API 基本完成后，需要与前端对齐接口字段和错误处理",
            reason="前端 Shell 已有进展，后端 API 完成后即可开始联调",
            goal="准备前后端联调并减少字段不一致返工",
            start_suggestion="对齐 ProjectState、Assignment、Check-in、Risk 和 ActionCard 的字段契约",
            completion_standard="前端能读取真实 API 数据并展示 loading、empty、error、success 状态",
            due_date="2026-06-04",
            status="active",
            created_by_agent=True,
            created_at=now,
        ),
        ActionCard(
            id="demo-action-005",
            project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaozhao"],
            task_id=TASK_IDS["agent_core"],
            type="personal_task",
            title="完成 Agent 核心闭环",
            content="实现 Clarification -> Planning -> Breakdown 的完整流程",
            reason="Agent 核心是产品核心价值，需要优先保证闭环",
            goal="跑通 Agent 从方向澄清到任务拆解的核心闭环",
            start_suggestion="先确认 clarify、plan、breakdown 的结构化 schema 输出和 fallback 路径",
            completion_standard="方向卡、阶段计划、任务拆解都能生成待确认提案并在确认后持久化",
            due_date="2026-06-05",
            status="active",
            created_by_agent=True,
            created_at=now,
        ),
    ]
    for ac in action_cards:
        session.add(ac)

    # -- Agent Events (timeline) --
    agent_events = [
        AgentEvent(
            id="demo-event-001",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            event_type="clarify",
            input_snapshot=json.dumps({"idea": project.idea}),
            output_snapshot=json.dumps({"direction_card": "confirmed"}),
            reasoning_summary="基于项目想法和调研结果，生成方向卡明确核心价值和边界",
            user_confirmed=True,
            created_at=now,
        ),
        AgentEvent(
            id="demo-event-002",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            event_type="plan",
            input_snapshot=json.dumps({"direction_card": "confirmed"}),
            output_snapshot=json.dumps({"stages": 4}),
            reasoning_summary="根据 6 周时间和交付物，拆分为调研、设计、实现、测试 4 个阶段",
            user_confirmed=True,
            created_at=now,
        ),
        AgentEvent(
            id="demo-event-003",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            event_type="breakdown",
            input_snapshot=json.dumps({"stage": "implementation"}),
            output_snapshot=json.dumps({"tasks": 3}),
            reasoning_summary="核心实现阶段需要前端、后端、Agent 三个 P0 任务并行",
            user_confirmed=True,
            created_at=now,
        ),
        AgentEvent(
            id="demo-event-004",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            event_type="assign",
            input_snapshot=json.dumps({"stage": "implementation", "tasks": 3}),
            output_snapshot=json.dumps({"proposals": 3}),
            reasoning_summary="根据成员技能、意向和可用时间推荐分工",
            user_confirmed=True,
            created_at=now,
        ),
        AgentEvent(
            id="demo-event-005",
            project_id=PROJECT_ID,
            workspace_id=WORKSPACE_ID,
            event_type="push",
            input_snapshot=json.dumps({"stage": "implementation"}),
            output_snapshot=json.dumps({"action_cards": 5}),
            reasoning_summary="基于当前任务状态和 check-in 结果生成分发任务卡和风险行动",
            user_confirmed=False,
            created_at=now,
        ),
    ]
    for ae in agent_events:
        session.add(ae)

    session.commit()

    return {
        "users": len(user_defs),
        "workspace": 1,
        "memberships": len(USER_IDS),
        "invitations": 5,
        "profiles": len(profiles),
        "project": 1,
        "resources": len(resources),
        "stages": len(stages),
        "tasks": len(tasks),
        "proposals": len(proposals),
        "checkin_cycles": 1,
        "checkin_responses": len(checkin_responses),
        "risks": len(risks),
        "action_cards": len(action_cards),
        "agent_events": len(agent_events),
    }
