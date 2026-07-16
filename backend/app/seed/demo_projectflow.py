"""Demo seed data for ProjectFlow MVP.

Creates a realistic 6-member student team with full project data
including ProjectMemory records, AgentProposal lifecycle, task status
history, a team conversation with messages, and retrieval index sync.

Narrative: The team builds ProjectFlow itself — an AI Agent that
actively pushes projects forward. The project spans ~7 weeks (June→July),
mirroring the real development cycle (Phase 0 → T45).

Seed date: 2026-07-16 (one day before defense). Project deadline = 07-17.
"""

import json
import logging
from datetime import datetime, timezone

from sqlmodel import Session

from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMembership
from app.models.invitation import Invitation
from app.models.member_profile import MemberProfile
from app.models.project import Project
from app.models.resource import ProjectResource
from app.models.stage import Stage
from app.models.task import Task, TaskStatusUpdate
from app.models.assignment import AssignmentProposal, AssignmentResponse, AssignmentNegotiation
from app.models.checkin import CheckInCycle, CheckInResponse
from app.models.risk import Risk
from app.models.action_card import ActionCard
from app.models.timeline import AgentEvent
from app.models.project_memory import ProjectMemory, ProjectMemorySync
from app.models.agent_proposal import AgentProposal
from app.models.agent_conversation import AgentConversation, AgentMessage


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
    "agent_architecture": "demo-task-030",
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

# ── Timeline anchors (UTC) — aligned to real ProjectFlow development ────
#  05-28  Phase 0 launch (repo init, scaffold)
#  06-07  Phase 0-41 done — MVP闭环跑通, direction card confirmed
#  06-08  Security review + T41 architecture design begins
#  07-04  T41 ADR confirmed (commit aecbb6c)
#  07-05  T41 S3-S16 implementation begins
#  07-06  Assignment responses in; 小王 raises concern → short negotiation resolved
#  07-08  Early check-in round; scope-expand proposal rejected
#  07-12  Mid check-in round; T43 Agent Harness V2 P0 done, backend blocker detected
#  07-13  T44/T45 done + production canary
#  07-14  Late check-in; push + replan after blocker persists
#  07-16  Today (seed date) — 1 day to deadline
#  07-17  Deadline
T_START = datetime(2026, 5, 28, 8, 0, 0, tzinfo=timezone.utc)
T_CLARIFY = datetime(2026, 6, 7, 20, 0, 0, tzinfo=timezone.utc)
T_PLAN = datetime(2026, 6, 8, 10, 0, 0, tzinfo=timezone.utc)
T_RESEARCH_DONE = datetime(2026, 6, 7, 18, 0, 0, tzinfo=timezone.utc)
T_DESIGN_DONE = datetime(2026, 7, 4, 18, 0, 0, tzinfo=timezone.utc)
T_BREAKDOWN = datetime(2026, 7, 5, 9, 0, 0, tzinfo=timezone.utc)
T_ASSIGN = datetime(2026, 7, 5, 21, 0, 0, tzinfo=timezone.utc)
T_ASSIGN_RESPONSE = datetime(2026, 7, 6, 10, 0, 0, tzinfo=timezone.utc)
T_NEGOTIATE = datetime(2026, 7, 6, 15, 0, 0, tzinfo=timezone.utc)
T_CHECKIN_EARLY = datetime(2026, 7, 8, 9, 0, 0, tzinfo=timezone.utc)
T_REJECTED = datetime(2026, 7, 8, 15, 0, 0, tzinfo=timezone.utc)
T_CHECKIN_MID = datetime(2026, 7, 12, 9, 0, 0, tzinfo=timezone.utc)
T_PUSH = datetime(2026, 7, 14, 9, 0, 0, tzinfo=timezone.utc)
T_REPLAN = datetime(2026, 7, 14, 22, 0, 0, tzinfo=timezone.utc)
T_NOW = datetime(2026, 7, 16, 8, 0, 0, tzinfo=timezone.utc)


def seed_demo_data(session: Session) -> dict:
    """Load demo seed data into the database. Returns a summary of created entities."""

    now = T_NOW

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
        user = User(id=USER_IDS[key], display_name=name, email=email,
                     created_at=T_START)
        session.add(user)
        users[key] = user
    session.flush()

    # -- Workspace --
    workspace = Workspace(
        id=WORKSPACE_ID,
        name="ProjectFlow 团队",
        owner_user_id=USER_IDS["xiaolin"],
        description="AI Agent 工程训练营项目小队",
        created_at=T_START,
        updated_at=T_START,
    )
    session.add(workspace)
    session.flush()

    # -- Memberships --
    for i, key in enumerate(USER_IDS):
        membership = WorkspaceMembership(
            id=f"demo-membership-{i+1:03d}",
            workspace_id=WORKSPACE_ID,
            user_id=USER_IDS[key],
            role="owner" if key == "xiaolin" else "member",
            joined_at=T_START,
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
            created_at=T_START,
            accepted_at=T_START,
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
            created_at=T_START, updated_at=T_START,
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
            created_at=T_START, updated_at=T_START,
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
            created_at=T_START, updated_at=T_START,
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
            created_at=T_START, updated_at=T_START,
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
            created_at=T_START, updated_at=T_START,
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
            created_at=T_START, updated_at=T_START,
        ),
    ]
    for p in profiles:
        session.add(p)
    session.flush()

    # -- Project --
    direction_card = json.dumps({
        "problem": "大学生项目小队缺乏持续的项目推进和风险感知能力",
        "users": "大学生项目小队（3-8人）",
        "value": "AI Agent 主动推进项目，持续回答下一步做什么、谁适合做、哪些有风险",
        "deliverables": ["MVP demo", "README", "demo video", "review summary"],
        "boundaries": ["约7周时间", "本地运行优先", "单 workspace", "不做多团队支持", "不做正式认证", "不做生产部署"],
        "risks": ["Agent 输出不稳定", "前后端联调困难", "LLM 响应延迟导致用户体验断流"],
        "suggested_questions": [
            "Agent 主动推进的边界怎么定义？哪些决策必须人类确认？",
            "如果真实LLM超时，降级路径是什么？",
        ],
        "source_summary": "基于团队成员调研（用户访谈 3-5 个团队）和竞品分析（Notion、Linear、飞书项目），结合约 7 周训练营时间约束和 AI Agent 工程方向",
        "assumptions": [
            "团队成员每周可投入 8-10 小时",
            "使用mock LLM可跑通完整流程，真实 LLM 作为升级选项",
            "SQLite 在本地运行场景性能足够",
            "评审关注产品完整性而非功能数量",
        ],
        "unknowns": [
            "真实LLM在多步编排下的稳定性和延迟",
            "Agent 多步编排下上下文膨胀到多少 token 需要压缩",
            "前后端联调阶段可能出现的字段不一致",
        ],
        "mvp_boundary": {
            "must_have": ["方向澄清 → 阶段计划 → 任务拆解 → 分工推荐 → 主动推进 → 风险识别 → 动态重排"],
            "defer": ["多团队 workspace", "正式认证和权限系统", "外部工具集成（飞书/GitHub）"],
            "out_of_scope": ["多端适配", "企业级部署", "多 Agent 架构", "文件解析"],
        },
        "decision_points": [
            "mock 模式与真实 LLM 的生产切换策略如何定？",
            "是否需要支持成员在线实时协作还是异步即可？",
            "评审导出格式用 Markdown 还是 PDF？",
        ],
        "reason": "基于调研结果和项目约束，方向聚焦在「主动推进型 Agent」而非通用看板，核心差异在于状态变化后的主动判断和推进建议",
    }, ensure_ascii=False)

    project = Project(
        id=PROJECT_ID,
        workspace_id=WORKSPACE_ID,
        name="ProjectFlow",
        idea="帮助大学生项目小队推进项目的 AI Agent，不只是记录任务，而是持续回答：项目该往哪走？下一步做什么？谁适合做什么？哪些有风险？",
        deadline="2026-07-17",
        deliverables="MVP demo, README, demo video, review summary",
        status="active",
        current_stage_id=None,
        direction_card=direction_card,
        created_by=USER_IDS["xiaolin"],
        created_at=T_START,
        updated_at=T_PUSH,
    )
    session.add(project)

    # -- Project Resources --
    resources = [
        ProjectResource(
            id="demo-resource-001",
            project_id=PROJECT_ID,
            type="text_note",
            title="训练营项目要求",
            content_text="约 7 周内完成一个 AI Agent 产品 MVP，需要包含：方向澄清、阶段计划、任务拆解、基于技能的自动分工推荐、签到分析、主动风险识别与预警、动态计划调整、一键导出评审摘要。评审关注产品完整性和 Agent 主动推进能力。",
            created_at=T_START,
        ),
        ProjectResource(
            id="demo-resource-002",
            project_id=PROJECT_ID,
            type="link",
            title="shadcn/ui 组件库",
            url="https://ui.shadcn.com/",
            created_at=T_START,
        ),
        ProjectResource(
            id="demo-resource-003",
            project_id=PROJECT_ID,
            type="text_note",
            title="技术栈决策",
            content_text="Next.js (React + TypeScript + Tailwind) + FastAPI (Python + SQLModel + Pydantic) + SQLite + TypeScript Agent Bridge (Pi 运行时)。Agent 生成提案，人类确认后才落库；确定性状态机控制流程，Agent 只在指定节点生成建议。",
            created_at=T_DESIGN_DONE,
        ),
    ]
    for r in resources:
        session.add(r)

    # -- Stages — aligned to real ProjectFlow development ────────────────
    stages = [
        Stage(
            id=STAGE_IDS["research"],
            project_id=PROJECT_ID,
            name="调研与方向",
            goal="明确项目方向、目标用户和核心价值",
            start_date="2026-05-28",
            end_date="2026-06-07",
            deliverable="方向卡、竞品分析报告、MVP 闭环验证",
            done_criteria=json.dumps(["方向卡已确认", "竞品分析完成", "目标用户明确", "MVP 闭环跑通"]),
            status="completed",
            order_index=0,
        ),
        Stage(
            id=STAGE_IDS["design"],
            project_id=PROJECT_ID,
            name="设计与规划",
            goal="完成安全审查、技术选型、Agent Runtime 架构设计",
            start_date="2026-06-08",
            end_date="2026-07-04",
            deliverable="安全审查报告、Agent Runtime 架构设计（ADR）、API 契约、UI 组件规划",
            done_criteria=json.dumps(["安全审查通过", "Agent Runtime 架构设计完成", "API 契约对齐", "阶段计划确认"]),
            status="completed",
            order_index=1,
        ),
        Stage(
            id=STAGE_IDS["implementation"],
            project_id=PROJECT_ID,
            name="核心实现",
            goal="实现 Agent Runtime 全切片、ProjectMemory、Agent Harness V2、效率与会话支持",
            start_date="2026-07-05",
            end_date="2026-07-14",
            deliverable="Agent 核心闭环、T41-T45 全部实现切片、UI 三栏布局、Agent 侧边栏",
            done_criteria=json.dumps(["Agent Runtime 全切片完成", "ProjectMemory 检索可用", "分工推荐可用", "关键页面完成"]),
            status="active",
            order_index=2,
        ),
        Stage(
            id=STAGE_IDS["testing"],
            project_id=PROJECT_ID,
            name="测试与打磨",
            goal="确保 Demo 稳定可运行，最终验证与交付准备",
            start_date="2026-07-15",
            end_date="2026-07-17",
            deliverable="稳定 Demo、演示脚本、评审摘要",
            done_criteria=json.dumps(["Demo 5分钟跑通", "无崩溃", "评审摘要导出"]),
            status="pending",
            order_index=3,
        ),
    ]
    for s in stages:
        session.add(s)
    session.flush()
    project.current_stage_id = STAGE_IDS["implementation"]

    # -- Tasks (due dates all ≤ 07-17; overdue tasks get explicit risk evidence) --
    tasks = [
        Task(
            id=TASK_IDS["user_research"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["research"],
            title="用户调研",
            description="调研大学生项目小队的痛点，访谈 3-5 个团队",
            priority="P0", status="done",
            owner_user_id=USER_IDS["xiaolin"],
            backup_owner_user_id=USER_IDS["xiaoliu"],
            assignment_reason="小林是项目负责人，沟通能力强，适合做用户访谈；小刘作为备选可协助整理访谈记录",
            due_date="2026-06-02", estimated_hours=6,
            acceptance_criteria=json.dumps(["访谈记录", "痛点总结"]),
            created_by_agent=True, updated_at=T_RESEARCH_DONE,
        ),
        Task(
            id=TASK_IDS["competitor_analysis"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["research"],
            title="竞品分析",
            description="分析 Notion、Linear、飞书项目等工具的不足",
            priority="P1", status="done",
            owner_user_id=USER_IDS["xiaoliu"],
            backup_owner_user_id=USER_IDS["xiaowang"],
            assignment_reason="小刘设计技能 3 级，擅长产品分析；小王有前端设计经验可作为备选",
            due_date="2026-06-04", estimated_hours=4,
            acceptance_criteria=json.dumps(["竞品对比表", "差异化分析"]),
            created_by_agent=True, updated_at=T_RESEARCH_DONE,
        ),
        Task(
            id=TASK_IDS["direction_card"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["research"],
            title="方向卡生成",
            description="基于调研结果生成项目方向卡",
            priority="P0", status="done",
            owner_user_id=USER_IDS["xiaolin"],
            backup_owner_user_id=USER_IDS["xiaozhao"],
            assignment_reason="小林掌握项目全局，适合收敛方向；小赵 AI/ML 技能 4 级可辅助 Agent 方向判断",
            due_date="2026-06-06", estimated_hours=3,
            acceptance_criteria=json.dumps(["方向卡确认", "目标用户明确"]),
            created_by_agent=True, updated_at=T_CLARIFY,
        ),
        Task(
            id=TASK_IDS["ui_design"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["design"],
            title="UI 设计与组件规划",
            description="设计核心页面布局和组件体系",
            priority="P0", status="done",
            owner_user_id=USER_IDS["xiaowang"],
            backup_owner_user_id=USER_IDS["xiaoliu"],
            assignment_reason="小王前端技能 4 级、设计技能 3 级，意向为前端/UI；小刘设计技能 3 级可协助",
            due_date="2026-06-15", estimated_hours=8,
            acceptance_criteria=json.dumps(["核心页面线框图", "组件列表"]),
            created_by_agent=True, updated_at=T_DESIGN_DONE,
        ),
        Task(
            id=TASK_IDS["api_design"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["design"],
            title="API 契约设计",
            description="定义前后端 API 接口和数据模型",
            priority="P0", status="done",
            owner_user_id=USER_IDS["xiaozhang"],
            backup_owner_user_id=USER_IDS["xiaoli"],
            assignment_reason="小张后端技能 4 级、数据库技能 3 级，意向为后端/数据；小李全栈技能可作为备选",
            due_date="2026-06-18", estimated_hours=6,
            acceptance_criteria=json.dumps(["API 文档", "数据结构定义"]),
            created_by_agent=True, updated_at=T_DESIGN_DONE,
        ),
        Task(
            id=TASK_IDS["agent_architecture"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["design"],
            title="Agent Runtime 架构设计",
            description="完成 T41 Agent Runtime 重构总方案：确定 FastAPI 事实源 + TypeScript Agent Bridge sidecar + Pi Runtime + 提案-确认模式的架构；设计 Tools 按效果分级（Read-only / Advisory Write / Proposal-only / 禁区）；完成 Skills 系统设计（SKILL.md 格式 + 选择器）；产出 ADR 决策记录",
            priority="P0", status="done",
            owner_user_id=USER_IDS["xiaozhao"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            assignment_reason="小赵 AI/ML 4 级、Prompt 工程 4 级，负责 Agent 方向的架构设计；小林全栈 4 级提供整体决策把关",
            due_date="2026-07-04", estimated_hours=14,
            acceptance_criteria=json.dumps(["Agent Runtime 总方案确认", "Tools & Skills 设计文档", "ADR 记录"]),
            created_by_agent=True, updated_at=T_DESIGN_DONE,
        ),
        Task(
            id=TASK_IDS["frontend_shell"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            title="前端框架与核心页面",
            description="搭建 Next.js + shadcn/ui 应用框架，实现三栏布局（左侧导航 + 中间内容 + 右侧 Agent 侧边栏），完成新手引导、工作区仪表盘、项目仪表盘、设置页面。经过三轮 UI 评审迭代",
            priority="P0", status="in_progress",
            owner_user_id=USER_IDS["xiaowang"],
            backup_owner_user_id=USER_IDS["xiaoliu"],
            assignment_reason="小王前端技能 4 级，意向为前端/UI，每周 10 小时可用；小刘设计技能 3 级可协助 UI 打磨",
            due_date="2026-07-10", estimated_hours=12,
            acceptance_criteria=json.dumps(["应用框架完成", "核心页面可交互"]),
            can_cut=False, created_by_agent=True, updated_at=T_PUSH,
        ),
        Task(
            id=TASK_IDS["backend_api"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            title="后端 API 与数据模型",
            description="实现 19 个数据模型（User/Workspace/Project/Stage/Task/Assignment/Risk/CheckIn/AgentEvent/AgentProposal/ProjectMemory 等）的 CRUD 接口，通过 FastAPI Pydantic schema 校验输入输出，完成 SQLite 外键约束与事务写入顺序安全加固",
            priority="P0", status="in_progress",
            owner_user_id=USER_IDS["xiaozhang"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            assignment_reason="小张后端技能 4 级、数据库技能 3 级，意向为后端/数据；小林后端技能 4 级可协助排查复杂问题",
            due_date="2026-07-10", estimated_hours=10,
            acceptance_criteria=json.dumps(["核心 API 可调用", "数据库 CRUD 正常"]),
            can_cut=False, created_by_agent=True, updated_at=T_PUSH,
        ),
        Task(
            id=TASK_IDS["agent_core"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            title="Agent 核心流程",
            description="实现 T41 Agent Runtime Sidecar（HTTP server + tool registry + policy gate + event bridge），完成 Read-only Tools（S5）、Stage Plan Proposal（S6）、Advisory Risk/ActionCard（S7）、Assignment Proposal（S8）、Check-in/replan migration（S9）、Event bridge + trace（S10）、Direction Card + Task Breakdown（S13）、Skills 系统（S14），以及 T42 ProjectMemory V1、T43 Agent Harness V2、T44 模型配置、T45 多会话历史",
            priority="P0", status="in_progress",
            owner_user_id=USER_IDS["xiaozhao"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            assignment_reason="小赵 AI/ML 技能 4 级、Prompt 工程 4 级，意向为 AI/Agent；小林全栈能力可协助调试",
            due_date="2026-07-14", estimated_hours=14,
            acceptance_criteria=json.dumps(["Agent 可生成方向卡", "可生成阶段计划", "可拆解任务"]),
            can_cut=False, created_by_agent=True, updated_at=T_PUSH,
        ),
        Task(
            id=TASK_IDS["integration_test"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["testing"],
            title="集成测试与 Demo 验证",
            description="端到端测试核心流程，确保 Demo 稳定",
            priority="P0", status="not_started",
            owner_user_id=USER_IDS["xiaoli"],
            backup_owner_user_id=USER_IDS["xiaozhao"],
            assignment_reason="小李全栈技能均衡，适合做端到端测试；小赵熟悉 Agent 流程可协助验证",
            due_date="2026-07-16", estimated_hours=8,
            acceptance_criteria=json.dumps(["核心流程测试通过", "Demo 无崩溃"]),
            created_by_agent=True, updated_at=T_ASSIGN,
        ),
        Task(
            id=TASK_IDS["demo_polish"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["testing"],
            title="Demo 打磨与演示脚本",
            description="打磨 UI、添加动画、编写演示脚本",
            priority="P1", status="not_started",
            owner_user_id=USER_IDS["xiaoliu"],
            backup_owner_user_id=USER_IDS["xiaowang"],
            assignment_reason="小刘设计技能 3 级，擅长产品展示；小王前端技能 4 级可协助动画和交互打磨",
            due_date="2026-07-17", estimated_hours=6,
            acceptance_criteria=json.dumps(["5分钟 Demo 跑通", "演示脚本完成"]),
            can_cut=True, created_by_agent=True, updated_at=T_ASSIGN,
        ),
    ]
    for t in tasks:
        session.add(t)
    session.flush()

    # -- Task Status Updates (history for 6 done tasks) --
    _task_statuses(session)

    # -- Assignment Proposals (for active stage) --
    proposals = _assignment_proposals(session)
    session.flush()

    # -- Assignment Responses (accept all with notes) --
    _assignment_responses(session)

    # -- Assignment Negotiation (小王前端动效拆分协商) --
    _assignment_negotiation(session)

    # -- Check-in Cycle --
    checkin_cycle = CheckInCycle(
        id=CHECKIN_CYCLE_ID,
        project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
        cadence_days=2, start_date="2026-07-05",
        next_due_date="2026-07-16", status="active",
        created_by_user_id=USER_IDS["xiaolin"],
        created_at=T_BREAKDOWN,
    )
    session.add(checkin_cycle)

    # -- Check-in Responses (6 members, 1 with blocker) --
    _checkin_responses(session)

    # -- Risks (evidence now includes overdue tasks) --
    _risks(session)

    # -- Action Cards --
    _action_cards(session)

    # -- Agent Events (backdated timeline, 2 new: replan + rejected proposal) --
    _agent_events(session)
    session.flush()

    # -- Agent Proposals (confirmed + rejected lifecycle) --
    _agent_proposals(session)
    session.flush()

    # -- Project Memories (7 types, FTS-indexed with ProjectMemorySync) --
    memories = _project_memories(session)

    # -- Agent Conversation + Messages (1 team-visible history) --
    _agent_conversation(session)

    session.commit()

    # ── Best-effort FTS5 indexing for seeded memories ────────────────────
    _index_memories(session, memories)
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
        "checkin_responses": 6,
        "risks": 3,
        "action_cards": 5,
        "agent_events": 8,
        "agent_proposals": 5,
        "project_memories": len(memories),
        "agent_conversations": 3,
    }


# ── Helper: Task status history ────────────────────────────────────────
def _task_statuses(session: Session) -> None:
    """Create status-update trajectory for all 6 done tasks."""
    updates = [
        # user_research
        TaskStatusUpdate(id="demo-tsu-001", task_id=TASK_IDS["user_research"],
                         user_id=USER_IDS["xiaolin"], status="in_progress",
                         progress_note="开始联系访谈对象",
                         created_at=datetime(2026, 5, 29, 10, 0, 0, tzinfo=timezone.utc)),
        TaskStatusUpdate(id="demo-tsu-002", task_id=TASK_IDS["user_research"],
                         user_id=USER_IDS["xiaolin"], status="done",
                         progress_note="完成 4 个团队访谈，整理痛点总结",
                         created_at=datetime(2026, 6, 2, 18, 0, 0, tzinfo=timezone.utc)),
        # competitor_analysis
        TaskStatusUpdate(id="demo-tsu-003", task_id=TASK_IDS["competitor_analysis"],
                         user_id=USER_IDS["xiaoliu"], status="in_progress",
                         progress_note="Notion 和 Linear 分析已初步完成",
                         created_at=datetime(2026, 5, 31, 14, 0, 0, tzinfo=timezone.utc)),
        TaskStatusUpdate(id="demo-tsu-004", task_id=TASK_IDS["competitor_analysis"],
                         user_id=USER_IDS["xiaoliu"], status="done",
                         progress_note="竞品对比表完成，提炼差异化方向",
                         created_at=datetime(2026, 6, 4, 20, 0, 0, tzinfo=timezone.utc)),
        # direction_card
        TaskStatusUpdate(id="demo-tsu-005", task_id=TASK_IDS["direction_card"],
                         user_id=USER_IDS["xiaolin"], status="in_progress",
                         progress_note="整合调研和竞品结论，起草方向卡",
                         created_at=datetime(2026, 6, 5, 10, 0, 0, tzinfo=timezone.utc)),
        TaskStatusUpdate(id="demo-tsu-006", task_id=TASK_IDS["direction_card"],
                         user_id=USER_IDS["xiaolin"], status="done",
                         progress_note="方向卡经团队确认，提案已锁定",
                         created_at=T_CLARIFY),
        # ui_design
        TaskStatusUpdate(id="demo-tsu-007", task_id=TASK_IDS["ui_design"],
                         user_id=USER_IDS["xiaowang"], status="in_progress",
                         progress_note="三栏布局草图已完成，进入组件列表梳理",
                         created_at=datetime(2026, 6, 10, 10, 0, 0, tzinfo=timezone.utc)),
        TaskStatusUpdate(id="demo-tsu-008", task_id=TASK_IDS["ui_design"],
                         user_id=USER_IDS["xiaowang"], status="done",
                         progress_note="核心页面线框图和组件列表已交付",
                         created_at=datetime(2026, 6, 15, 18, 0, 0, tzinfo=timezone.utc)),
        # api_design
        TaskStatusUpdate(id="demo-tsu-009", task_id=TASK_IDS["api_design"],
                         user_id=USER_IDS["xiaozhang"], status="in_progress",
                         progress_note="数据模型初步定版，API 路由表起草中",
                         created_at=datetime(2026, 6, 12, 10, 0, 0, tzinfo=timezone.utc)),
        TaskStatusUpdate(id="demo-tsu-010", task_id=TASK_IDS["api_design"],
                         user_id=USER_IDS["xiaozhang"], status="done",
                         progress_note="API 文档和数据结构定义完成，前后端对齐",
                         created_at=datetime(2026, 6, 18, 18, 0, 0, tzinfo=timezone.utc)),
        # agent_architecture
        TaskStatusUpdate(id="demo-tsu-011", task_id=TASK_IDS["agent_architecture"],
                         user_id=USER_IDS["xiaozhao"], status="in_progress",
                         progress_note="完成状态机流程和提案-确认模式方案初稿，起草 Tools 分级设计",
                         created_at=datetime(2026, 6, 18, 10, 0, 0, tzinfo=timezone.utc)),
        TaskStatusUpdate(id="demo-tsu-012", task_id=TASK_IDS["agent_architecture"],
                         user_id=USER_IDS["xiaozhao"], status="done",
                         progress_note="Agent Runtime 总方案、Tools & Skills 设计和 ADR 全部完成，团队评审通过",
                         created_at=T_DESIGN_DONE),
    ]
    for u in updates:
        session.add(u)


# ── Helper: Assignment Proposals ───────────────────────────────────────
def _assignment_proposals(session: Session) -> list:
    ps = [
        AssignmentProposal(
            id=PROPOSAL_IDS["frontend_shell"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            task_id=TASK_IDS["frontend_shell"],
            recommended_owner_user_id=USER_IDS["xiaowang"],
            backup_owner_user_id=USER_IDS["xiaoliu"],
            reason="小王前端技能 4 级，设计技能 3 级，且意向为前端/UI，每周 10 小时可用",
            skill_match="前端技能 4 级匹配 P0 前端任务",
            availability_match="每周 10 小时满足 12 小时预估",
            preference_match="意向「前端/UI」匹配",
            constraint_respected="周三晚上有课与任务截止无冲突",
            risk_note="小王周三晚上有课，可能影响进度",
            status="finalized", created_by_agent=True,
            created_at=T_ASSIGN,
        ),
        AssignmentProposal(
            id=PROPOSAL_IDS["backend_api"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            task_id=TASK_IDS["backend_api"],
            recommended_owner_user_id=USER_IDS["xiaozhang"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            reason="小张后端技能 4 级，数据库技能 3 级，意向为后端/数据",
            skill_match="后端技能 4 级 + 数据库 3 级匹配 P0 后端任务",
            availability_match="每周 8 小时可覆盖核心工作",
            preference_match="意向「后端/数据」匹配",
            constraint_respected="已确认工作日可投入，周末回家不影响核心 API 开发",
            risk_note="小张周末经常回家，可用时间偏少",
            status="finalized", created_by_agent=True,
            created_at=T_ASSIGN,
        ),
        AssignmentProposal(
            id=PROPOSAL_IDS["agent_core"],
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            task_id=TASK_IDS["agent_core"],
            recommended_owner_user_id=USER_IDS["xiaozhao"],
            backup_owner_user_id=USER_IDS["xiaolin"],
            reason="小赵 AI/ML 技能 4 级，Prompt 工程 4 级，意向为 AI/Agent",
            skill_match="AI/ML 4 级 + Prompt 工程 4 级匹配 Agent 核心",
            availability_match="每周 8 小时覆盖 14 小时预估（2 周）",
            preference_match="意向「AI/Agent」高度匹配",
            constraint_respected="晚上 10 点后不在线——Agent 调试安排在日间；如 LLM 调用需晚间，小林补位",
            risk_note="小赵晚上 10 点后不在线，Agent 调试可能需要晚间时间",
            status="finalized", created_by_agent=True,
            created_at=T_ASSIGN,
        ),
    ]
    for p in ps:
        session.add(p)
    return ps


# ── Helper: Assignment Responses ────────────────────────────────────────
def _assignment_responses(session: Session) -> None:
    responses = [
        AssignmentResponse(
            id="demo-ar-001", proposal_id=PROPOSAL_IDS["frontend_shell"],
            user_id=USER_IDS["xiaowang"], response="accept",
            reason="前端框架是我的强项，周五前完成新手引导",
            created_at=T_ASSIGN_RESPONSE,
        ),
        AssignmentResponse(
            id="demo-ar-002", proposal_id=PROPOSAL_IDS["backend_api"],
            user_id=USER_IDS["xiaozhang"], response="accept",
            reason="没问题，API 设计阶段已经熟悉数据模型了",
            created_at=T_ASSIGN_RESPONSE,
        ),
        AssignmentResponse(
            id="demo-ar-003", proposal_id=PROPOSAL_IDS["agent_core"],
            user_id=USER_IDS["xiaozhao"], response="accept",
            reason="正好想深入 LLM 编排，但 14 小时有点紧，有阻塞随时找小林",
            created_at=T_ASSIGN_RESPONSE,
        ),
    ]
    for r in responses:
        session.add(r)


# ── Helper: Assignment Negotiation ─────────────────────────────────────
def _assignment_negotiation(session: Session) -> None:
    """07-06: 小王接受前端分工后提出动画部分的协商——小刘接手动效实现."""
    # Agent detected the concern and suggested task redistribution
    neg = AssignmentNegotiation(
        id="demo-negotiation-001",
        project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
        from_user_id=USER_IDS["xiaowang"],
        desired_task_id=TASK_IDS["frontend_shell"],
        current_owner_user_id=USER_IDS["xiaowang"],
        status="resolved",
        agent_message="小王接受前端框架任务但反馈动效实现部分耗时偏多、希望拆分。Agent 分析成员技能后建议：动画与微交互由小刘（design 4 + animation 3）接手，小王专注三栏布局和页面组件的 TypeScript 逻辑。协商后双方同意：小王负责框架与组件逻辑（原 12h 降为 10h），小刘从 demo_polish 任务中分 4h 做动效与过渡动画",
        created_at=T_NEGOTIATE,
    )
    session.add(neg)


# ── Helper: Check-in Responses ─────────────────────────────────────────
def _checkin_responses(session: Session) -> None:
    """6 check-ins spread across 3 cycles (early/mid/late implementation)."""
    responses = [
        # ── 07-08 early cycle ──
        CheckInResponse(
            id="demo-checkin-resp-001", cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaowang"], task_id=TASK_IDS["frontend_shell"],
            what_done="完成应用框架和左侧导航组件，三栏布局骨架搭好",
            blocker=None, available_hours_next_cycle=10,
            mood_or_confidence="high",
            created_at=T_CHECKIN_EARLY,
        ),
        CheckInResponse(
            id="demo-checkin-resp-003", cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaozhao"], task_id=TASK_IDS["agent_core"],
            what_done="完成 LLM 客户端和协调器骨架，开始对接 tool registry",
            blocker=None, available_hours_next_cycle=8,
            mood_or_confidence="high",
            created_at=T_CHECKIN_EARLY,
        ),
        CheckInResponse(
            id="demo-checkin-resp-005", cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaoliu"],
            task_id=TASK_IDS["demo_polish"],
            what_done="初步整理了 UI 组件的视觉风格指南，确定圆角/间距/配色规范",
            blocker=None, available_hours_next_cycle=6,
            mood_or_confidence="high",
            created_at=T_CHECKIN_EARLY,
        ),
        # ── 07-12 mid cycle ──
        CheckInResponse(
            id="demo-checkin-resp-002", cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaozhang"], task_id=TASK_IDS["backend_api"],
            what_done="完成了用户和工作区的增删改查接口",
            blocker="SQLite 外键约束报错，还在排查",
            available_hours_next_cycle=8,
            mood_or_confidence="medium",
            created_at=T_CHECKIN_MID,
        ),
        CheckInResponse(
            id="demo-checkin-resp-004", cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaoli"],
            task_id=TASK_IDS["integration_test"],
            what_done="整理完核心流程的测试用例清单，覆盖方向卡→计划→拆解→分工的主链路",
            blocker=None, available_hours_next_cycle=10,
            mood_or_confidence="medium",
            created_at=T_CHECKIN_MID,
        ),
        # ── 07-14 late cycle ──
        CheckInResponse(
            id="demo-checkin-resp-006", cycle_id=CHECKIN_CYCLE_ID,
            project_id=PROJECT_ID, stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaolin"],
            what_done="排查后端外键阻塞：定位到 Flush 顺序问题，确认是 demo_projectflow.py 写入顺序与 FK 约束不一致",
            blocker=None, available_hours_next_cycle=12,
            mood_or_confidence="medium",
            created_at=T_PUSH,
        ),
    ]
    for cr in responses:
        session.add(cr)


# ── Helper: Risks ──────────────────────────────────────────────────────
def _risks(session: Session) -> None:
    risks = [
        Risk(
            id="demo-risk-001", project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            task_id=TASK_IDS["backend_api"],
            type="dependency", severity="medium",
            title="后端 API 外键约束问题",
            description="小张报告 SQLite 外键约束报错，可能影响后端 API 进度。任务原定 7 月 10 日完成，已逾期 4 天",
            evidence=json.dumps([
                "小张签到报告阻塞项: SQLite 外键约束报错",
                "后端 API 是 P0 任务，阻塞前端联调",
                "任务 due 2026-07-10，已逾期 4 天，本次签到未报告任何进展",
            ]),
            recommendation="小林协助排查外键问题；如果 1 天内无法解决，考虑简化数据模型",
            status="open", created_by_agent=True,
            created_at=T_PUSH,
        ),
        Risk(
            id="demo-risk-002", project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            type="workload", severity="high",
            title="小张可用时间下降 + 后端 API 逾期",
            description="小张下周期可用时间从 8 小时降至 6 小时，且后端 API（due 07-10）已逾期 4 天。两项叠加使后端成为项目最大瓶颈",
            evidence=json.dumps([
                "小张签到报告下周期可用时间: 6",
                "小张资料: 每周可用时间: 8",
                "小张周末经常回家",
                "后端 API 原定 07-10 完成，当前仍在排查阻塞（已逾期 4 天）",
                "前端框架已完成等待联调，Agent 核心接近闭环",
            ]),
            recommendation="考虑将部分后端工作分配给小林（后端技能 4 级），或削减非核心 API",
            status="open", created_by_agent=True,
            created_at=T_PUSH,
        ),
        Risk(
            id="demo-risk-003", project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            type="deadline", severity="medium",
            title="核心实现阶段逾期 2 天 + 测试窗口仅剩 1 天",
            description="核心实现阶段原定 07-14 截止，现已逾期 2 天。3 个 P0 任务仅 agent_core 接近闭环，后端联调仍未开始。测试阶段 07-15 已启动但完全被尾留任务挤占，当前可用的集成测试时间仅剩 07-17 一天",
            evidence=json.dumps([
                "3 个 P0 任务同时进行中，无 1 个完成",
                "阶段截止 2026-07-14，已逾期 2 天",
                "Agent 核心预估 14 小时，接近闭环",
                "后端 API 逾期 6 天，前端联调未开始",
                "测试阶段 07-15 已启动，但实际测试时间仅剩 07-17 一天",
                "距离 deadline 07-17 仅剩 1 天",
            ]),
            recommendation="放弃后端联调，前端用 mock 数据验证完整闭环。Agent 核心今天务必跑通方向卡→计划→拆解的主链路。集成测试明早 2 小时快速冒烟，重点验证核心链路不崩溃",
            status="open", created_by_agent=True,
            created_at=T_NOW,
        ),
    ]
    for r in risks:
        session.add(r)


# ── Helper: Action Cards ───────────────────────────────────────────────
def _action_cards(session: Session) -> None:
    cards = [
        ActionCard(
            id="demo-action-001", project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaowang"], task_id=TASK_IDS["frontend_shell"],
            type="personal_task",
            title="继续前端框架开发",
            content="完成新手引导流程和工作区仪表盘页面，同时准备后端 API 的 mock 数据用于独立验证",
            reason="你的前端框架任务进展顺利，签到显示已完成导航组件。后端 API 暂被阻塞，先做独立可推进的部分",
            goal="完成前端框架和核心页面的可用闭环（含 mock 数据）",
            start_suggestion="先检查新手引导、工作区仪表盘和项目仪表盘的加载态与空态",
            completion_standard="核心页面可进入、可刷新、可展示 mock 数据且无页面崩溃；后端接口恢复后替换为真实数据",
            due_date="2026-07-15", status="active",
            created_by_agent=True, created_at=T_PUSH,
        ),
        ActionCard(
            id="demo-action-002", project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaozhang"], task_id=TASK_IDS["backend_api"],
            type="personal_task",
            title="解决 SQLite 外键约束问题",
            content="排查外键约束报错原因，修复后继续实现 Assignment 和 CheckIn API。你的任务已逾期，优先降低阻塞风险",
            reason="你的签到报告了阻塞项，这是 P0 任务的关键阻塞。逾期 4 天需要尽快止损",
            goal="解除后端 API 阻塞，恢复前后端联调",
            start_suggestion="复现外键约束报错并定位失败接口、模型关系和写入事务；如无法定位则联系小林",
            completion_standard="分工、签到和任务状态接口可被前端调用且冒烟测试通过",
            due_date="2026-07-16", status="active",
            created_by_agent=True, created_at=T_PUSH,
        ),
        ActionCard(
            id="demo-action-003", project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaolin"], type="risk_action",
            title="协助小张排查外键问题",
            content="小张报告后端外键约束报错，你的后端技能 4 级可以协助。任务已逾期 3 天，需优先止损",
            reason="后端 API 是 P0 任务且已逾期 4 天，阻塞前端联调和 Agent 集成测试",
            goal="在半天内解除后端阻塞风险",
            start_suggestion="和小张一起看外键约束报错堆栈，确认是否是数据模型或事务写入顺序问题",
            completion_standard="给出修复方案或明确可接受的简化数据模型方案",
            due_date="2026-07-16", status="active",
            created_by_agent=True, created_at=T_REPLAN,
        ),
        ActionCard(
            id="demo-action-004", project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            type="team_next_step",
            title="前后端联调准备",
            content="后端接口恢复后，需要与前端对齐接口字段和错误处理。小王先用 mock 数据验证前端",
            reason="前端框架已有进展，后端接口恢复后即可开始联调。避免等后端恢复后再对齐字段导致二次返工",
            goal="准备前后端联调并减少字段不一致返工",
            start_suggestion="对齐 ProjectState、Assignment、Check-in、Risk 和 ActionCard 的字段契约",
            completion_standard="前端能读取真实数据并展示加载中、空数据、错误、成功四种状态",
            due_date="2026-07-16", status="active",
            created_by_agent=True, created_at=T_REPLAN,
        ),
        ActionCard(
            id="demo-action-005", project_id=PROJECT_ID,
            stage_id=STAGE_IDS["implementation"],
            user_id=USER_IDS["xiaozhao"], task_id=TASK_IDS["agent_core"],
            type="personal_task",
            title="完成 Agent 核心闭环",
            content="实现方向澄清 → 阶段计划 → 任务拆解的完整流程，每个模块输出结构化提案待确认",
            reason="Agent 核心是产品核心价值，当前接近闭环，需优先保证 07-15 前完成",
            goal="跑通 Agent 从方向澄清到任务拆解的核心闭环",
            start_suggestion="先确认方向澄清、阶段计划、任务拆解的结构化输出和降级兜底路径",
            completion_standard="方向卡、阶段计划、任务拆解都能生成待确认提案并在确认后持久化",
            due_date="2026-07-15", status="active",
            created_by_agent=True, created_at=T_PUSH,
        ),
    ]
    for ac in cards:
        session.add(ac)


# ── Helper: Agent Events (timeline, backdated) ──────────────────────────
def _agent_events(session: Session) -> None:
    """Agent event timeline — strictly chronological by created_at.

    Order: clarify(06-07) → plan(06-08) → breakdown(07-05) → assign(07-05)
           → negotiate(07-06) → scope_rejected(07-08) → push(07-14) → replan(07-14)
    """
    events = [
        AgentEvent(
            id="demo-event-001", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            event_type="clarify",
            input_snapshot=json.dumps({"idea": "帮助大学生项目小队推进项目的 AI Agent"}),
            output_snapshot=json.dumps({"direction_card": "confirmed"}),
            reasoning_summary="基于 5 月底启动的用户调研（小林访谈 4 个团队，小刘完成 Notion/Linear/飞书竞品分析），Agent 生成方向卡：聚焦「主动推进型 AI Agent」，通过提案-确认模式保证 Agent 输出可审查。明确 MVP 边界为单工作区、本地运行、约 7 周时间窗口",
            user_confirmed=True, created_at=T_CLARIFY,
        ),
        AgentEvent(
            id="demo-event-002", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            event_type="plan",
            input_snapshot=json.dumps({"direction_card": "confirmed"}),
            output_snapshot=json.dumps({"stages": 4}),
            reasoning_summary="基于已确认的方向卡和约 7 周时间窗口，Agent 生成 4 阶段计划：调研与方向（11 天）→ 设计与规划（27 天，含安全审查+T41 架构设计）→ 核心实现（10 天）→ 测试与打磨（3 天）。设计规划阶段最长是因为 Agent Runtime 架构设计需要深度调研和 ADR 决策",
            user_confirmed=True, created_at=T_PLAN,
        ),
        AgentEvent(
            id="demo-event-003", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            event_type="breakdown",
            input_snapshot=json.dumps({"stage": "implementation"}),
            output_snapshot=json.dumps({"tasks": 3}),
            reasoning_summary="Agent 将核心实现阶段拆解为 3 个 P0 任务并行推进：前端框架与核心页面（小王，12h，due 07-10）、后端 API 与数据模型（小张，10h，due 07-10）、Agent 核心流程（小赵，14h，due 07-14）。测试阶段另有集成测试（due 07-16）和 Demo 打磨（due 07-17）2 个任务",
            user_confirmed=True, created_at=T_BREAKDOWN,
        ),
        AgentEvent(
            id="demo-event-004", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            event_type="assign",
            input_snapshot=json.dumps({"stage": "implementation", "tasks": 3}),
            output_snapshot=json.dumps({"proposals": 3, "confirmed": 3}),
            reasoning_summary="根据成员技能、意向和可用时间推荐分工：小王（前端 4 级）→ 前端框架，小张（后端 4 级）→ 后端 API，小赵（AI/ML+Prompt 双 4 级）→ Agent 核心。三人次日上午均已确认接受",
            user_confirmed=True, created_at=T_ASSIGN,
        ),
        AgentEvent(
            id="demo-event-008", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            event_type="negotiate",
            input_snapshot=json.dumps({"assignment": "frontend_shell", "concern": "动效耗时偏高"}),
            output_snapshot=json.dumps({"negotiation": "resolved"}),
            reasoning_summary="7 月 6 日下午小王确认前端分工后反馈动效实现耗时偏高，希望拆分。Agent 分析成员技能组合：小刘 design 4 级 + animation 3 级，且 demo_polish 任务尚未启动（6h 中有弹性空间）。建议动效部分由小刘接手（从 demo_polish 分 4h），小王专注三栏布局和 TypeScript 组件逻辑。协商快速达成一致——展示了 Agent 在分工确认后的实时协调能力",
            user_confirmed=True, created_at=T_NEGOTIATE,
        ),
        AgentEvent(
            id="demo-event-007", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            event_type="clarify",
            input_snapshot=json.dumps({"proposal_type": "scope_expand"}),
            output_snapshot=json.dumps({"result": "rejected"}),
            reasoning_summary="7 月 8 日下午有人提议把方向卡范围扩大到支持多 Agent 架构——但超出 MVP 边界。团队讨论后否决：当前 3 个 P0 任务已并行且后端刚遇阻塞，任何 scope 扩张都会导致 07-17 截止日风险失控。记录为 proposal_rejected 记忆，防止后续类似提案重复讨论",
            user_confirmed=True, created_at=T_REJECTED,
        ),
        AgentEvent(
            id="demo-event-005", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            event_type="push",
            input_snapshot=json.dumps({"stage": "implementation"}),
            output_snapshot=json.dumps({"action_cards": 4, "risks": 2}),
            reasoning_summary="7 月 14 日上午主动推进分析：检测到小张签到报告 SQLite 外键约束阻塞且后端 API 已逾期 4 天 → 生成风险行动卡（小林协助排查）；小王前端进展顺利 → 续推前端框架（含 mock 数据独立验证）；小赵 Agent 骨架完成 → 推 Agent 闭环；生成后端 API 阻塞风险和可用时间下降风险（high severity）。共生成 4 张行动卡和 2 条风险",
            user_confirmed=False, created_at=T_PUSH,
        ),
        AgentEvent(
            id="demo-event-006", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            event_type="replan",
            input_snapshot=json.dumps({"risks": ["backend_overdue", "xiaozhang_availability_drop"]}),
            output_snapshot=json.dumps({"replan_proposal": "confirmed"}),
            reasoning_summary="7 月 14 日深夜紧急重排会议：小林接手后端 API 外键修复（后端技能 4 级），小张转为辅助并专注数据模型，后端 API due 从 07-10 推迟至 07-16。前端先走 mock 数据独立验证，避免等后端阻塞。测试阶段 07-15 已启动但被尾留任务挤占。团队确认重排方案",
            user_confirmed=True, created_at=T_REPLAN,
        ),
    ]
    for ae in events:
        session.add(ae)


# ── Helper: Agent Proposals (confirmed + rejected lifecycle) ────────────
def _agent_proposals(session: Session) -> None:
    proposals_data = [
        AgentProposal(
            id="demo-ap-001", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            proposal_type="clarify", status="confirmed",
            agent_event_id="demo-event-001",
            payload=json.dumps({"output_type": "direction_card"}),
            confirmed_by=USER_IDS["xiaolin"],
            confirmed_at=T_CLARIFY,
            created_at=T_CLARIFY,
        ),
        AgentProposal(
            id="demo-ap-002", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            proposal_type="plan", status="confirmed",
            agent_event_id="demo-event-002",
            payload=json.dumps({"output_type": "stage_plan", "stages": 4}),
            confirmed_by=USER_IDS["xiaolin"],
            confirmed_at=T_PLAN,
            created_at=T_PLAN,
        ),
        AgentProposal(
            id="demo-ap-003", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            proposal_type="breakdown", status="confirmed",
            agent_event_id="demo-event-003",
            payload=json.dumps({"output_type": "task_breakdown", "tasks": 5}),
            confirmed_by=USER_IDS["xiaolin"],
            confirmed_at=T_BREAKDOWN,
            created_at=T_BREAKDOWN,
        ),
        AgentProposal(
            id="demo-ap-004", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            proposal_type="replan", status="confirmed",
            agent_event_id="demo-event-006",
            payload=json.dumps({
                "output_type": "replan",
                "changes": [
                    "backend_api owner 小林接手（之前: 小张）",
                    "backend_api due 07-10 → 07-16",
                    "frontend_shell 先走 mock 数据独立验证",
                ],
                "reason": "后端 API 逾期 4 天且小张可用时间下降",
            }),
            confirmed_by=USER_IDS["xiaolin"],
            confirmed_at=T_REPLAN,
            created_at=T_REPLAN,
        ),
        AgentProposal(
            id="demo-ap-005", project_id=PROJECT_ID, workspace_id=WORKSPACE_ID,
            proposal_type="clarify", status="rejected",
            agent_event_id="demo-event-007",
            payload=json.dumps({
                "output_type": "scope_expand",
                "proposed": "支持多 Agent 架构",
                "reason_for_rejection": "超出 MVP 边界，核心实现阶段 3 个 P0 任务已并行且后端刚遇阻塞，任何 scope 扩张都会导致 07-17 截止日风险失控",
            }),
            rejection_reason="超出 MVP 边界，当前阶段 3 个 P0 任务已并行且后端刚遇阻塞，任何 scope 扩张都会导致截止日风险失控",
            created_at=T_REJECTED,
        ),
    ]
    for ap in proposals_data:
        session.add(ap)


# ── Helper: Project Memories (7 types + ProjectMemorySync) ──────────────
def _project_memories(session: Session) -> list:
    """Create 7 memory records covering all V1 memory_type values.

    Includes 1 subject_and_owner visibility record (member_constraint)
    to demonstrate memory privacy boundaries.
    """
    now = T_NOW
    memories = [
        # 1. direction (source=direction_card_confirmed)
        ProjectMemory(
            id="demo-memory-001", workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
            memory_type="direction", scope="project",
            content="ProjectFlow 聚焦「主动推进型 AI Agent」而非通用看板工具。核心差异化：Agent 不是被动等待用户操作，而是在状态变化后主动判断是否需要调整计划、推荐分工、识别风险。采用提案-确认架构——Agent 生成建议，人类确认后落库，保证 Agent 输出可审查、可追溯",
            rationale="方向卡确认时团队达成共识：核心价值是「Agent 的主动推进能力」，而非功能数量。舍弃通用看板路径，集中资源做方向澄清→阶段计划→任务拆解→分工推荐→主动推进→风险识别→动态重排的核心闭环",
            source_type="direction_card_confirmed", source_id="demo-ap-001",
            status="active", visibility="team",
            related_stage_id=STAGE_IDS["research"],
            created_at=T_CLARIFY, updated_at=T_CLARIFY,
        ),
        # 2. boundary (source=direction_card_confirmed)
        ProjectMemory(
            id="demo-memory-002", workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
            memory_type="boundary", scope="project",
            content="MVP 范围约束：单 workspace 本地运行、不做多团队支持、不做正式认证系统、不做生产部署。可推迟项：外部工具集成（飞书/GitHub）、多端适配。不做项：多 Agent 架构、文件解析、企业级部署。技术栈：Next.js + FastAPI + SQLite + TypeScript Agent Bridge (Pi Runtime)",
            rationale="方向卡确认时的明确取舍——所有「好做但不是核心」的需求推迟到项目结束后。每个阶段的交付物聚焦在核心闭环上。这验证了团队在有限时间内做出了合理的产品边界决策",
            source_type="direction_card_confirmed", source_id="demo-ap-001",
            status="active", visibility="team",
            related_stage_id=STAGE_IDS["research"],
            created_at=T_CLARIFY, updated_at=T_CLARIFY,
        ),
        # 3. plan (source=replan_confirmed, from mid-phase replan)
        ProjectMemory(
            id="demo-memory-003", workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
            memory_type="plan", scope="project",
            content="核心实现阶段重排计划（07-14）：小林接手后端 API 外键修复并推进至联调就绪（due 07-16），小张转为辅助并专注数据模型一致性和测试用例。前端先走 mock 数据独立验证，不等后端阻塞解除。测试阶段 07-15 已启动但被尾留任务挤占，07-17 当天预留上午最终集成和下午交付",
            rationale="7 月 14 日重排会议：后端 API 已逾期 4 天且小张可用时间从 8h 降至 6h，继续单人推进风险过高。小林后端 4 级接手修复是时间最优解；前端走 mock 是并行推进策略，避免空闲等后端。测试窗口仅 3 天（07-15~07-17），不可进一步压缩",
            source_type="replan_confirmed", source_id="demo-ap-004",
            status="active", visibility="team",
            related_stage_id=STAGE_IDS["implementation"],
            created_at=T_REPLAN, updated_at=T_REPLAN,
        ),
        # 4. assignment (source=assignment_confirmed)
        ProjectMemory(
            id="demo-memory-004", workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
            memory_type="assignment", scope="task",
            content="小赵（AI/ML 4 级 + Prompt 工程 4 级）负责 Agent 核心流程（预估 14 小时），小林（后端 4 级 + 项目管理 4 级）为备选。核心风险：Agent 调试时间因 LLM 响应不稳定可能超出预估。缓解措施：每条 Agent 输出路径实现降级兜底机制",
            rationale="分工确认时的核心决策：Agent 是产品差异化关键，需要最强 AI/ML 技能的成员负责。Agent 工程需要同时理解 LLM 行为和后端确定性逻辑——小赵的 AI/ML + Prompt 工程双 4 级完美匹配",
            source_type="assignment_confirmed", source_id="demo-ap-003",
            status="active", visibility="team",
            subject_user_id=USER_IDS["xiaozhao"],
            owner_user_id_snapshot=USER_IDS["xiaozhao"],
            related_task_id=TASK_IDS["agent_core"],
            created_at=T_ASSIGN, updated_at=T_ASSIGN,
        ),
        # 5. tradeoff (source=replan_confirmed)
        ProjectMemory(
            id="demo-memory-005", workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
            memory_type="tradeoff", scope="project",
            content="重排会议取舍原则（7 月 14 日确认）：(1) 核心链路稳定性 > 功能数量——宁可少覆盖 1 个模块也要保证不崩溃；(2) Agent 主动推进闭环 > 边缘场景覆盖——方向卡→计划→拆解→分工→风险→重排的主链路优先；(3) 确定性兜底 > LLM 冒险——默认使用 mock LLM 保证行为可预测，真实 LLM 作为特定场景的升级选项",
            rationale="后端 API 阻塞和第 3 个 deadline 风险同时出现，团队必须在功能范围和可靠性之间做权衡。回顾方向卡阶段评估的「Agent 输出不稳定」和「LLM 响应延迟」风险，当前最优解是把有限的窗口聚焦在核心链路的稳定性上",
            source_type="replan_confirmed", source_id="demo-ap-004",
            status="active", visibility="team",
            related_stage_id=STAGE_IDS["implementation"],
            created_at=T_REPLAN, updated_at=T_REPLAN,
        ),
        # 6. rejection (source=proposal_rejected, with mandatory reason)
        ProjectMemory(
            id="demo-memory-006", workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
            memory_type="rejection", scope="project",
            content="7 月 8 日拒绝「支持多 Agent 架构」的 scope 扩张提案。拒绝理由：超出 MVP 边界（方向卡明确列为 out_of_scope），当前核心实现阶段 3 个 P0 任务已并行且后端刚遇阻塞，任何 scope 扩张都会导致 07-17 截止日风险失控。后续类似提案应引用此记忆避免重复讨论",
            rationale="方向卡阶段已明确「多 Agent 架构」为不做项。提案出现时正值后端 API 遇到阻塞、核心实现时间紧张，驳回是合理的产品决策。记录为项目记忆可防止后续阶段或新成员再次提出类似 scope creep",
            source_type="proposal_rejected", source_id="demo-ap-005",
            status="active", visibility="team",
            related_stage_id=STAGE_IDS["implementation"],
            created_at=T_REJECTED, updated_at=T_REJECTED,
        ),
        # 7. member_constraint (source=assignment_confirmed, visibility=subject_and_owner)
        ProjectMemory(
            id="demo-memory-007", workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
            memory_type="member_constraint", scope="member",
            content="小赵（AI/Agent 负责人）：晚上 10 点后不在线。Agent 调试和 LLM 调用安排在日间；如需晚间执行长推理任务，由备选负责人小林补位。此约束在分工确认阶段已纳入任务时间评估",
            rationale="分工确认时检查组发现小赵的「晚上 10 点后不在线」约束可能影响 Agent 调试（LLM 调用常需晚间低负载时段）。缓解方案：日间优先调度 Agent 调试，晚间如需 LLM 调用由小林负责。约束记录为 member_constraint 记忆可被后续分工推荐阶段自动引用",
            source_type="assignment_confirmed", source_id="demo-ap-003",
            status="active", visibility="subject_and_owner",
            subject_user_id=USER_IDS["xiaozhao"],
            owner_user_id_snapshot=USER_IDS["xiaozhao"],
            related_task_id=TASK_IDS["agent_core"],
            created_at=T_ASSIGN, updated_at=T_ASSIGN,
        ),
    ]
    for m in memories:
        session.add(m)
    session.flush()

    # Create ProjectMemorySync records (same semantics as memory_service._persist_candidates)
    for m in memories:
        sync = ProjectMemorySync(
            memory_id=m.id,
            backend="fts5",
            backend_memory_id=m.id,
            sync_status="pending",  # Will be updated to "synced" or "failed" by _index_memories
            last_synced_at=None,
            last_error=None,
        )
        session.add(sync)

    return memories


# ── Helper: Agent Conversations + Messages ─────────────────────────────
def _agent_conversation(session: Session) -> None:
    """Create team-visible conversations at key project phases.

    Each captures concrete moments from real development — architecture
    trade-offs, LLM output debugging, model selection with data.
    """
    _conv_architecture(session)
    _conv_agent_stability(session)
    _conv_model_and_memory(session)


def _conv_architecture(session: Session) -> None:
    """06-08: \u8bbe\u8ba1\u89c4\u5212\u9636\u6bb5\u2014\u2014Agent \u4e0e\u540e\u7aef\u7684\u8fb9\u754c\u5212\u5206."""
    conv = AgentConversation(
        id="demo-conversation-001",
        workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
        creator_user_id=USER_IDS["xiaolin"],
        title="Agent \u4e0e\u540e\u7aef\u8fb9\u754c\u600e\u4e48\u5212",
        visibility="team", status="active",
        summary="\u5c0f\u6797\u68b3\u7406\u5b8c\u6280\u672f\u65b9\u6848\u540e\u5728 Agent \u5199\u5e93\u6743\u9650\u3001sidecar \u90e8\u7f72\u7406\u7531\u3001\u5de5\u5177\u5206\u7ea7\u4e0a\u4e0e Agent \u8ba8\u8bba\u5177\u4f53\u8fb9\u754c",
        created_at=T_PLAN, updated_at=T_PLAN,
    )
    session.add(conv)
    session.flush()

    msgs = [
        AgentMessage(
            id="demo-msg-a1", conversation_id=conv.id, role="user",
            content="\u6211\u753b\u4e86\u5f20\u8349\u56fe\uff1a\u524d\u7aef Next.js \u5c55\u793a\u9879\u76ee\u4eea\u8868\u76d8\u548c Agent \u5efa\u8bae \u2192 \u540e\u7aef FastAPI \u5904\u7406 CRUD \u2192 Agent \u8c03 LLM \u751f\u6210\u5efa\u8bae\u3002\u73b0\u5728\u5361\u5728\u4e00\u4e2a\u95ee\u9898\u4e0a\u2014\u2014Agent \u751f\u6210\u7684\u65b9\u5411\u5361\u3001\u9636\u6bb5\u8ba1\u5212\u8fd9\u4e9b\uff0c\u662f\u76f4\u63a5\u5199\u6570\u636e\u5e93\u8fd8\u662f\u53ea\u8fd4\u56de\u7ed9\u524d\u7aef\uff1f\u5982\u679c Agent \u80fd\u76f4\u63a5\u5199\u5e93\uff0c\u4e07\u4e00\u5b83\u751f\u6210\u9519\u4e86\u65b9\u5411\u5361\uff0c\u7528\u6237\u8fde\u64a4\u56de\u7684\u673a\u4f1a\u90fd\u6ca1\u6709\u3002",
            created_at=datetime(2026, 6, 8, 10, 5, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-a2", conversation_id=conv.id, role="assistant",
            content="Agent \u7edd\u5bf9\u4e0d\u80fd\u76f4\u63a5\u5199\u5e93\u3002\u8fd9\u4e0d\u662f\u4fe1\u4efb\u95ee\u9898\u2014\u2014\u662f\u53ef\u63a7\u6027\u3002\n\n\u9009\u63d0\u6848-\u786e\u8ba4\u6a21\u5f0f\uff1aAgent \u751f\u6210\u7684\u662f Proposal \u5bf9\u8c61\uff08\u5982 DirectionCardProposal\uff09\uff0c\u524d\u7aef\u5c55\u793a\u7ed9\u7528\u6237\uff0c\u7528\u6237\u70b9\u201c\u786e\u8ba4\u201d\u540e\u524d\u7aef\u8c03 POST /proposals/{id}/confirm \u2192 \u540e\u7aef\u624d\u662f\u552f\u4e00\u843d\u5730 Agent \u8f93\u51fa\u5230 Project/Stage/Task \u8868\u7684\u5730\u65b9\u3002\n\n\u597d\u5904\uff1a\n- Agent \u8f93\u51fa\u88ab\u62d2\u7edd\u65f6\uff0c\u62d2\u7edd\u7406\u7531\u53ef\u4ee5\u4f5c\u4e3a\u9879\u76ee\u8bb0\u5fc6\u7559\u5b58\uff08\u65b9\u5411\u5361\u9636\u6bb5 memory_type=rejection \u7684\u6765\u6e90\uff09\n- \u7528\u6237\u53ef\u4ee5\u5728\u786e\u8ba4\u524d\u7f16\u8f91\u63d0\u6848\u5185\u5bb9\n- \u6240\u6709\u5199\u5e93\u64cd\u4f5c\u90fd\u5728\u4e00\u4e2a\u4e8b\u52a1\u91cc\uff0cFK \u7ea6\u675f\u4e0d\u4f1a\u56e0\u4e3a Agent \u4e71\u5199\u800c\u7834\u574f\n\n\u4ee3\u4ef7\u662f\u524d\u7aef\u591a\u4e86\u4e00\u4e2a\u786e\u8ba4\u6b65\u9aa4\u2014\u2014\u4f46\u5bf9\u4e8e\u9ad8\u5f71\u54cd\u51b3\u7b56\uff08\u65b9\u5411\u3001\u8ba1\u5212\u3001\u5206\u5de5\uff09\uff0c\u8fd9\u6b65\u662f\u5fc5\u8981\u7684\u3002",
            created_at=datetime(2026, 6, 8, 10, 5, 30, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-a3", conversation_id=conv.id, role="user",
            content="\u90a3 Agent Bridge \u90e8\u7f72\u6210\u72ec\u7acb\u8fdb\u7a0b\uff08sidecar\uff0c\u7aef\u53e3 4000\uff09\u7684\u539f\u56e0\u662f\u4ec0\u4e48\uff1f\u5982\u679c\u5199\u6210 FastAPI \u7684\u4e00\u4e2a service \u6a21\u5757\uff0c\u8c03 LLM \u65f6\u7528 httpx \u5f02\u6b65\u8bf7\u6c42\u4e0d\u5c31\u884c\u4e86\uff1f\u591a\u4e00\u4e2a\u8fdb\u7a0b\u591a\u4e00\u4e2a\u90e8\u7f72\u6b65\u9aa4\u3002",
            created_at=datetime(2026, 6, 8, 10, 8, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-a4", conversation_id=conv.id, role="assistant",
            content="\u4e0d\u662f\u56e0\u4e3a\u5f02\u6b65\u4e0d\u591f\u2014\u2014\u800c\u662f\u8fd0\u884c\u6a21\u578b\u622a\u7136\u4e0d\u540c\u3002\n\nFastAPI \u662f\u77ed\u8fde\u63a5\u8bf7\u6c42-\u54cd\u5e94\uff1a\u63a5\u6536 HTTP \u2192 \u5904\u7406 \u2192 \u8fd4\u56de JSON\uff0c\u4e00\u4e2a\u8bf7\u6c42\u751f\u547d\u5468\u671f\u51e0\u6beb\u79d2\u3002\n\nAgent \u662f\u957f\u8fde\u63a5\u6709\u72b6\u6001\uff1aLLM \u6d41\u5f0f SSE \u63a8\u9001 token\u3001tool-call \u5faa\u73af\uff08\u8c03 tool \u2192 \u62ff\u5230\u7ed3\u679c \u2192 \u6ce8\u5165 context \u2192 \u7ee7\u7eed\u63a8\u7406 \u2192 \u518d\u8c03 tool\uff09\u3001\u4e0a\u4e0b\u6587\u538b\u7f29\u3001checkpoint \u6062\u590d\u3002\u4e00\u4e2a Agent run \u53ef\u80fd\u6301\u7eed 30-120s\u3002\n\n\u5982\u679c\u5168\u585e\u5728 FastAPI \u91cc\uff0cuvicorn \u7684 async worker \u4f1a\u88ab Agent run \u957f\u65f6\u95f4\u5360\u7528\u3002\u62c6\u6210 sidecar \u540e\uff1aFastAPI \u4e13\u6ce8 CRUD + \u63d0\u6848\u786e\u8ba4\uff08\u5feb\uff09\uff0csidecar \u4e13\u6ce8 Agent \u8fd0\u884c\u65f6\uff08\u6162\u4f46\u6709\u72b6\u6001\u63a7\u5236\uff09\uff0c\u4e24\u8005\u901a\u8fc7 internal API\uff08Bearer token\uff09\u901a\u4fe1\u3002\n\n\u90e8\u7f72\u4e0a\u53ea\u662f\u591a\u4e86\u4e00\u4e2a `npm run start`\u2014\u2014\u672c\u5730\u5f00\u53d1\u5b8c\u5168\u4e0d\u662f\u95ee\u9898\u3002",
            created_at=datetime(2026, 6, 8, 10, 8, 30, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-a5", conversation_id=conv.id, role="user",
            content="\u8fd8\u6709\u4e00\u4e2a\u8fb9\u754c\u95ee\u9898\u6ca1\u60f3\u6e05\u695a\uff1aAgent \u8c03\u7528 tool \u7684\u65f6\u5019\uff0ccreate_risk \u662f\u76f4\u63a5\u843d\u5e93\u7684\u2014\u2014\u8fd9\u548c\u201c\u63d0\u6848\u786e\u8ba4\u201d\u77db\u76fe\u5417\uff1f\u5982\u679c\u98ce\u9669\u5206\u6790\u4e86\u534a\u5929\u7ed3\u679c agent \u81ea\u5df1\u5c31\u628a\u98ce\u9669\u5361\u5199\u4e86\uff0c\u7528\u6237\u4ec0\u4e48\u90fd\u4e0d\u77e5\u9053\u3002",
            created_at=datetime(2026, 6, 8, 10, 12, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-a6", conversation_id=conv.id, role="assistant",
            content="\u4e0d\u77db\u76fe\uff0ccreate_risk \u53ea\u521b\u5efa Risk \u8bb0\u5f55\u2014\u2014\u8fd9\u4e0d\u662f\u201c\u9ad8\u5f71\u54cd\u4e3b\u4e8b\u5b9e\u201d\u3002\n\n\u533a\u5206\u7ebf\uff1a\n\n**Advisory Write \u2014 Agent \u76f4\u63a5\u5199\u3001\u4e0d\u963b\u585e**\n- create_risk\uff1a\u4e00\u6761\u98ce\u9669\u5361\u53ea\u662f\u201c\u63d0\u793a\u201d\uff0c\u4e0d\u5f71\u54cd project.status\u3001task.owner\u3001stage.plan\n- create_checkin\uff1a\u540c\u7406\uff0c\u7b7e\u5230\u53ea\u662f\u6210\u5458\u81ea\u5df1\u586b\u7684\u5185\u5bb9\n\n**Proposal \u2014 Agent \u751f\u6210\u3001\u4eba\u7c7b\u786e\u8ba4\u540e\u624d\u5199\u5e93**\n- generate_stage_plan \u2192 \u786e\u8ba4\u540e\u6539 project.current_stage \u548c Stage \u8868\n- breakdown_tasks \u2192 \u786e\u8ba4\u540e\u5199 Task \u8868\n- recommend_assignment \u2192 \u786e\u8ba4\u540e\u5199 AssignmentProposal \u2192 finalized\n- generate_replan \u2192 \u786e\u8ba4\u540e\u6539 task.owner/date/stage\n\n\u8bb0\u4f4f\u4e00\u53e5\uff1a\u98ce\u9669\u5361\u672c\u8eab\u4e0d\u53d7\u63a7\u2014\u2014\u4f46\u98ce\u9669\u7684\u7f13\u89e3\u65b9\u6848\uff08\u6539 owner\u3001\u63a8\u8fdf deadline\uff09\u5fc5\u987b\u8d70 replan proposal\u3002",
            created_at=datetime(2026, 6, 8, 10, 12, 40, tzinfo=timezone.utc),
        ),
    ]
    for m in msgs:
        session.add(m)


def _conv_agent_stability(session: Session) -> None:
    """07-08: \u5b9e\u73b0\u9636\u6bb5\u2014\u2014LLM JSON \u8f93\u51fa\u4e0d\u7a33\u5b9a & fallback \u8bbe\u8ba1."""
    conv = AgentConversation(
        id="demo-conversation-002",
        workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
        creator_user_id=USER_IDS["xiaozhao"],
        title="LLM JSON \u8f93\u51fa\u4e0d\u7a33\u5b9a\u600e\u4e48\u515c\u5e95",
        visibility="team", status="active",
        summary="\u5c0f\u8d75\u8054\u8c03 direction_card \u751f\u6210\u65f6\u9047\u5230 DeepSeek Flash JSON \u5b57\u6bb5\u7f3a\u5931/\u591a\u4f59\uff0c\u8ba8\u8bba Pydantic \u6821\u9a8c\u2192JSON \u4fee\u590d\u2192fallback \u4e09\u5c42\u7b56\u7565\u7684\u5177\u4f53\u5b9e\u73b0",
        created_at=T_REJECTED, updated_at=T_REJECTED,
    )
    session.add(conv)
    session.flush()

    msgs = [
        AgentMessage(
            id="demo-msg-b1", conversation_id=conv.id, role="user",
            content="direction_card \u6a21\u5757\u8c03\u4e86 4 \u6b21 DeepSeek Flash\uff0c\u6bcf\u6b21 prompt \u91cc\u7528\u4e86\u540c\u6837\u7684 DirectionCardOutput schema \u63cf\u8ff0\uff0c\u4f46\u8fd4\u56de\u7684 JSON\uff1a\u7b2c 2 \u6b21\u7f3a\u5c11\u2018risks\u2019\u5b57\u6bb5\uff0c\u7b2c 3 \u6b21\u591a\u4e86\u4e00\u4e2a\u53eb\u2018suggested_tools\u2019\u7684 key\uff08schema \u91cc\u6839\u672c\u6ca1\u6709\uff09\uff0c\u53ea\u6709\u7b2c 1 \u548c\u7b2c 4 \u6b21\u6b63\u5e38\u3002\u6211\u5728 output_schemas.py \u91cc\u5b9a\u4e49\u4e86 DirectionCardOutput(BaseModel)\uff0c\u4f46 Pydantic \u6821\u9a8c\u78b0\u5230\u7f3a\u5931\u5b57\u6bb5\u76f4\u63a5 raise ValidationError\u2014\u2014\u7528\u6237\u7aef\u770b\u5230\u7684\u662f\u7a7a\u767d\u3002\u8fd9\u79cd\u60c5\u51b5\u5e94\u8be5\u600e\u4e48\u5904\u7406\uff0c\u53ea\u9760 Pydantic \u4e0d\u591f\u5427\uff1f",
            created_at=datetime(2026, 7, 8, 10, 0, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-b2", conversation_id=conv.id, role="assistant",
            content="Pydantic \u53ea\u505a\u6821\u9a8c\u2014\u2014\u6821\u9a8c\u5931\u8d25\u4e4b\u540e\u600e\u4e48\u505a\u624d\u662f\u5173\u952e\u3002\u65b9\u5411\u5361\u9636\u6bb5\u7684\u98ce\u9669\u8868\u5df2\u7ecf\u628a\u201cAgent \u8f93\u51fa\u4e0d\u7a33\u5b9a\u201d\u5217\u51fa\u6765\u4e86\uff0c\u73b0\u5728\u843d\u5730\u4e09\u5c42\uff1a\n\n**\u7b2c\u4e00\u5c42\uff1aPydantic \u6821\u9a8c\uff08schema validation\uff09**\n\u5b9a\u4e49\u597d DirectionCardOutput \u7684\u5fc5\u586b\u5b57\u6bb5\u548c\u7c7b\u578b\u3002\u6821\u9a8c\u4e0d\u901a\u8fc7 \u2192 \u4e0d\u8fd4\u56de\u7ed9\u7528\u6237\uff0c\u8fdb\u5165\u7b2c\u4e8c\u5c42\u3002\n\n**\u7b2c\u4e8c\u5c42\uff1aJSON \u4fee\u590d + \u91cd\u8bd5**\n\u5e38\u89c1\u4fee\u590d\u573a\u666f\uff1a\n- LLM \u8f93\u51fa\u5305\u88f9\u5728 ```json ... ``` markdown \u4ee3\u7801\u5757\u91cc \u2192 \u6b63\u5219\u5265\u6389\n- \u591a\u4e86\u5c3e\u9017\u53f7 \u2192 json.loads \u4e4b\u524d\u7528 regex \u53bb\u6389\n- \u5b57\u6bb5\u540d\u9519\u4e86\uff08\u6bd4\u5982 outputs \u4ee3\u66ff output\uff09\u2192 \u7ef4\u62a4\u4e00\u4e2a\u5e38\u89c1 typo \u6620\u5c04\u8868\n\n\u4fee\u590d\u540e re-parse \u2192 \u5982\u679c\u901a\u8fc7\u6821\u9a8c\uff0c\u6b63\u5e38\u8fd4\u56de\u3002\u5982\u679c\u8fd8\u662f\u5931\u8d25 \u2192 \u628a\u5931\u8d25\u539f\u56e0\u62fc\u5230 prompt \u672b\u5c3e\uff0c\u91cd\u8bd5\u4e00\u6b21\uff08\u544a\u8bc9 LLM \u201c\u4f60\u7684\u4e0a\u6b21\u8f93\u51fa\u7f3a\u5c11 risks \u5b57\u6bb5\u201d\uff09\u3002\n\n**\u7b2c\u4e09\u5c42\uff1a\u6a21\u677f\u5316 fallback**\n\u4e24\u6b21\u91cd\u8bd5\u90fd\u5931\u8d25 \u2192 \u8d70 fallback\uff1a\u4e0d\u8c03 LLM\uff0c\u76f4\u63a5\u7528\u5f53\u524d project \u72b6\u6001 + \u6210\u5458 skills \u751f\u6210 DirectionCardOutput \u7684\u9ed8\u8ba4\u503c\u3002\u6807\u8bb0 is_fallback=true \u8ba9\u524d\u7aef\u663e\u793a\u201c\u57fa\u7840\u5efa\u8bae\u00b7\u9700\u4eba\u7c7b\u5ba1\u67e5\u201d\u3002",
            created_at=datetime(2026, 7, 8, 10, 0, 30, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-b3", conversation_id=conv.id, role="user",
            content="fallback \u751f\u6210\u7684 DirectionCardOutput \u5982\u679c\u592a\u6b7b\u677f\u4f1a\u4e0d\u4f1a\u6ca1\u7528\uff1f\u6bd4\u5982\u65b9\u5411\u5361 fallback \u53ea\u662f\u628a project.idea \u539f\u6587\u585e\u8fdb direction \u5b57\u6bb5\u2014\u2014\u7528\u6237\u770b\u5230\u7684\u548c\u6ca1\u8c03 Agent \u4e00\u6837\u3002",
            created_at=datetime(2026, 7, 8, 10, 3, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-b4", conversation_id=conv.id, role="assistant",
            content="fallback \u4e0d\u9700\u8981\u201c\u806a\u660e\u201d\uff0c\u9700\u8981\u7684\u662f\u201c\u53ef\u7528\u7684\u7ed3\u6784\u5316\u6570\u636e\u201d\u3002\u4e0d\u8981\u7ea0\u7ed3\u5185\u5bb9\u8d28\u91cf\u2014\u2014fallback \u7684\u573a\u666f\u662f LLM \u5b8c\u5168\u4e0d\u53ef\u7528\uff08\u8d85\u65f6\u6216\u683c\u5f0f\u5168\u574f\uff09\uff0c\u8fd9\u65f6\u5019\u7528\u6237\u9700\u8981\u7684\u4e0d\u662f\u201cAI \u7684\u6d1e\u89c1\u201d\u800c\u662f\u201c\u4e0d\u4e2d\u65ad\u6d41\u7a0b\u201d\u3002\n\n\u5177\u4f53\u505a\uff1a\n1. \u4ece\u786e\u5b9a\u6027\u6e90\u53d6\u6570\u636e\uff1aproject.idea\u3001tasks \u5217\u8868\u3001members.skills\n2. \u7528\u6a21\u677f\u7ec4\u88c5\u6210\u7ed3\u6784\u5316\u8f93\u51fa\uff1aDirectionCardOutput \u7684\u6240\u6709\u5fc5\u586b\u5b57\u6bb5\u90fd\u6709\u503c\uff0c\u4f46 reason \u5b57\u6bb5\u5199\u201c\u57fa\u4e8e\u9879\u76ee\u6570\u636e\u81ea\u52a8\u751f\u6210\uff0c\u975e LLM \u5206\u6790\u201d\n3. \u524d\u7aef\u6e32\u67d3\u65f6\u52a0\u6a59\u8272 tag\uff1a\u201c\u4ee5\u4e0b\u4e3a\u57fa\u7840\u5efa\u8bae\uff0c\u8bf7\u68c0\u67e5\u5e76\u7f16\u8f91\u540e\u518d\u786e\u8ba4\u201d\n\n\u5b81\u53ef\u7ed9\u7528\u6237\u4e00\u4e2a\u6734\u5b9e\u7684\u3001\u57fa\u4e8e\u4e8b\u5b9e\u7684\u6a21\u677f\uff0c\u4e5f\u4e0d\u80fd\u7ed9\u4e00\u4e2a LLM \u778e\u7f16\u7684\u201c\u770b\u8d77\u6765\u6709\u9053\u7406\u201d\u7684\u65b9\u6848\u3002",
            created_at=datetime(2026, 7, 8, 10, 3, 20, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-b5", conversation_id=conv.id, role="user",
            content="\u521a\u624d\u8c03 DeepSeek API \u53c8\u8d85\u65f6\u4e86\u4e00\u6b21\u2014\u2014\u6211\u8bbe\u4e86 60s timeout\uff0c\u4f46\u8fd9\u662f\u4eca\u5929\u7b2c\u4e8c\u6b21\u4e86\u3002\u8d85\u65f6\u4e4b\u540e\u7528\u6237\u90a3\u8fb9\u7684\u4f53\u9a8c\u662f\uff1a\u70b9\u4e86\u201c\u751f\u6210\u65b9\u5411\u5361\u201d\u2192 \u7b49\u4e86 60s \u2192 \u4ec0\u4e48\u90fd\u6ca1\u53d1\u751f\u3002\u80fd\u4e0d\u80fd\u8ba9\u8d85\u65f6\u81ea\u52a8\u8d70 fallback\uff0c\u7528\u6237\u4e0d\u9700\u8981\u624b\u52a8\u91cd\u8bd5\uff1f",
            created_at=datetime(2026, 7, 8, 10, 6, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-b6", conversation_id=conv.id, role="assistant",
            content="\u80fd\u3002\u5728 llm_client.py \u7684 call_with_timeout \u91cc\u505a\uff1a\n\n1. httpx.TimeoutException \u6216 60s \u8d85\u65f6 \u2192 \u4e0d\u629b\u7ed9\u8c03\u7528\u65b9\uff0c\u76f4\u63a5\u8fd4\u56de\u4e00\u4e2a\u6807\u8bb0 result_source='timeout' \u7684\u54cd\u5e94\n2. \u4e0a\u5c42\u6a21\u5757\uff08\u5982 direction_card_generator.py\uff09\u6536\u5230 timeout \u6807\u8bb0 \u2192 \u8df3\u8fc7 LLM \u8f93\u51fa\uff0c\u4e0d\u8fdb\u5165 Pydantic \u6821\u9a8c \u2192 \u76f4\u63a5\u8d70 fallback\n3. \u540c\u65f6\u5728 Agent \u7aef\u7684 SSE \u91cc\u63a8\u9001\u4e00\u6761 status \u4e8b\u4ef6\uff1a\u201cLLM \u54cd\u5e94\u8d85\u65f6\uff0c\u5df2\u81ea\u52a8\u5207\u6362\u4e3a\u57fa\u7840\u5efa\u8bae\u6a21\u5f0f\u201d\n\n\u8fd9\u6837\u7528\u6237\u770b\u5230\u7684\u662f\uff1a\u70b9\u4e86\u751f\u6210 \u2192 \u9694\u4e86\u51e0\u79d2 \u2192 \u51fa\u73b0\u65b9\u5411\u5361\uff08\u5e26\u6a59\u8272 fallback \u63d0\u793a\uff09\u2192 \u6ca1\u6709\u62a5\u9519\u3001\u6ca1\u6709\u7a7a\u767d\u3002\n\n\u8d85\u65f6\u7684 root cause \u662f DeepSeek \u670d\u52a1\u7aef\u8d1f\u8f7d\u2014\u2014Flash \u7684 SLA \u662f 30s \u5185\u8fd4\u56de\uff0c\u5076\u5c14\u8d85 60s \u8bf4\u660e\u5f53\u65f6\u5e76\u53d1\u9ad8\u3002\u65b9\u5411\u5361\u4e0d\u662f\u9ad8\u9891\u573a\u666f\uff0c\u91cd\u8bd5\u7b56\u7565\u53ef\u4ee5\u4fdd\u5b88\uff08\u53ea retry 1 \u6b21\uff09\uff0cfallback \u515c\u5e95\u5c31\u662f\u5bf9\u7684\u3002",
            created_at=datetime(2026, 7, 8, 10, 6, 20, tzinfo=timezone.utc),
        ),
    ]
    for m in msgs:
        session.add(m)


def _conv_model_and_memory(session: Session) -> None:
    """07-14: \u5b9e\u73b0\u5c3e\u58f0\u2014\u2014\u6a21\u578b\u9009\u62e9\u4e0e\u9879\u76ee\u8bb0\u5fc6\u4f7f\u7528\u9a8c\u8bc1."""
    conv = AgentConversation(
        id="demo-conversation-003",
        workspace_id=WORKSPACE_ID, project_id=PROJECT_ID,
        creator_user_id=USER_IDS["xiaolin"],
        title="\u6a21\u578b\u600e\u4e48\u9009 & Agent \u8bb0\u4e0d\u8bb0\u5f97\u6211\u4eec\u7684\u51b3\u7b56",
        visibility="team", status="active",
        summary="\u5c0f\u6797\u53d1\u73b0 Flash \u5206\u5de5\u63a8\u8350\u628a\u4efb\u52a1\u5168\u63a8\u7ed9\u5c0f\u738b\u540e\u8be2\u95ee\u6a21\u578b\u9009\u62e9\uff0c\u5e76\u5b9e\u9645\u6d4b\u8bd5 Agent \u5bf9\u62d2\u7edd\u63d0\u6848\u548c\u6210\u5458\u7ea6\u675f\u7684\u8bb0\u5fc6\u5f15\u7528",
        created_at=T_REPLAN, updated_at=T_REPLAN,
    )
    session.add(conv)
    session.flush()

    msgs = [
        AgentMessage(
            id="demo-msg-c1", conversation_id=conv.id, role="user",
            content="\u4eca\u5929\u7528\u9ed8\u8ba4\u7684 Flash \u6a21\u578b\u751f\u6210\u5206\u5de5\u63a8\u8350\uff0c\u7ed3\u679c\u628a 3 \u4e2a P0 \u4efb\u52a1\u5168\u63a8\u7ed9\u4e86\u5c0f\u738b\u3002\u6211\u5207\u5230 Pro \u91cd\u65b0\u751f\u6210\u4e86\u4e00\u6b21\uff0c\u8fd9\u6b21\u5c31\u6b63\u5e38\u4e86\u2014\u2014\u4e09\u4e2a\u4eba\u5404\u81ea\u5206\u5230\u5339\u914d\u7684\u4efb\u52a1\uff0c\u8fd8\u9644\u4e86\u7ea6\u675f\u68c0\u67e5\u8bc1\u636e\u3002\u4ee5\u540e\u5206\u5de5\u63a8\u8350\u662f\u4e0d\u662f\u90fd\u5f97\u7528 Pro\uff1f\u8fd8\u6709\u54ea\u4e9b\u529f\u80fd\u4e5f\u5e94\u8be5\u5207 Pro\uff1f",
            created_at=datetime(2026, 7, 14, 21, 10, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-c2", conversation_id=conv.id, role="assistant",
            content="\u4f60\u9047\u5230\u7684\u662f Flash \u5728\u591a\u7ef4\u5ea6\u51b3\u7b56\u4e0a\u7684\u5178\u578b\u5931\u8d25\u6a21\u5f0f\uff1a\u5b83\u53ea\u770b\u4e86\u6280\u80fd\u5339\u914d\u5ea6\u8fd9\u4e00\u7ef4\uff08\u5c0f\u738b frontend 4 \u7ea7\u6700\u9ad8\uff09\uff0c\u5ffd\u7565\u4e86\u53ef\u7528\u65f6\u95f4\u548c\u5de5\u4f5c\u91cf\u5747\u8861\u3002\n\n\u5efa\u8bae\u7684\u5206\u5de5\u89c4\u5219\uff1a\n\n**\u9700\u8981 Pro \u7684\u573a\u666f\uff08\u591a\u7ef4\u4ea4\u53c9\u5224\u65ad\uff09**\n- \u5206\u5de5\u63a8\u8350\uff1a\u6280\u80fd \u00d7 \u65f6\u95f4 \u00d7 \u610f\u5411 \u00d7 \u7ea6\u675f\n- \u91cd\u6392\u5206\u6790\uff1adeadline \u00d7 \u5269\u4f59\u5de5\u65f6 \u00d7 \u4efb\u52a1\u4f9d\u8d56\n- \u65b9\u5411\u6f84\u6e05\uff1a\u4ece\u8c03\u7814\u6570\u636e\u63d0\u53d6\u6d1e\u5bdf\n\n**Flash \u5c31\u591f\u7684\u573a\u666f\uff08\u5355\u4e00\u7ef4\u5ea6\uff09**\n- \u7b7e\u5230\u5206\u6790\uff1a\u5904\u7406 blocker \u5b57\u6bb5\n- \u884c\u52a8\u5361\u751f\u6210\uff1a\u6309\u4f18\u5148\u7ea7\u6392\u5e8f\n- \u65e5\u5e38\u95ee\u7b54\uff1a\u9879\u76ee\u72b6\u6001\u67e5\u8be2\n\n\u6210\u672c\u53c2\u8003\uff1aPro \u5355\u6b21\u7ea6 $0.065\uff0cFlash \u7ea6 $0.017\u3002\u6309\u4e0a\u9762\u89c4\u5219\u5206\u6d41\u540e\uff0c\u4f4e\u9891\u9ad8\u4ef7\u503c\u573a\u666f\u7528 Pro \u7684\u6210\u672c\u5b8c\u5168\u53ef\u63a5\u53d7\u3002\u53ef\u4ee5\u5728\u8bbe\u7f6e\u9875\u7684\u6a21\u578b\u914d\u7f6e\u91cc\u628a Pro \u8bbe\u4e3a\u5206\u5de5/\u91cd\u6392\u573a\u666f\u7684\u9ed8\u8ba4\u3002",
            created_at=datetime(2026, 7, 14, 21, 10, 30, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-c3", conversation_id=conv.id, role="user",
            content="\u6362\u4e2a\u95ee\u9898\u3002\u4eca\u5929\u7fa4\u91cc\u53c8\u6709\u4eba\u63d0\u80fd\u4e0d\u80fd\u52a0\u591a Agent \u534f\u4f5c\u2014\u2014\u6211\u8bb0\u5f97\u6211\u4eec\u4e4b\u524d\u5426\u51b3\u8fc7\u4e00\u6b21\u7c7b\u4f3c\u63d0\u6848\u3002\u4f60\u8fd8\u8bb0\u5f97\u5f53\u65f6\u62d2\u7edd\u7684\u5177\u4f53\u7406\u7531\u5417\uff1f\u5e2e\u6211\u628a\u5b83\u6574\u7406\u51fa\u6765\uff0c\u6211\u76f4\u63a5\u53d1\u7fa4\u91cc\u3002",
            created_at=datetime(2026, 7, 14, 21, 15, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-c4", conversation_id=conv.id, role="assistant",
            content="\u8bb0\u5f97\u30027 \u6708 8 \u65e5\u56e2\u961f\u5426\u51b3\u4e86\u300c\u652f\u6301\u591a Agent \u67b6\u6784\u300d\u7684 scope \u6269\u5f20\u63d0\u6848\uff0c\u5f53\u65f6\u7684\u62d2\u7edd\u7406\u7531\u6709\u4e09\u6761\uff08\u6765\u81ea\u9879\u76ee\u8bb0\u5fc6\u7684 rejection \u8bb0\u5f55\uff09\uff1a\n\n1. **\u65b9\u5411\u5361\u5df2\u660e\u786e\u5217\u4e3a\u4e0d\u505a\u9879**\uff1a\u591a Agent \u67b6\u6784\u5728 out_of_scope \u6e05\u5355\u91cc\uff0c\u548c\u4f01\u4e1a\u7ea7\u90e8\u7f72\u3001\u6587\u4ef6\u89e3\u6790\u5e76\u5217\n2. **\u65f6\u673a\u98ce\u9669**\uff1a\u63d0\u6848\u51fa\u73b0\u65f6\u6b63\u503c\u6838\u5fc3\u5b9e\u73b0\u9636\u6bb5 3 \u4e2a P0 \u5e76\u884c\u4e14\u540e\u7aef\u521a\u9047\u963b\u585e\uff0c\u4efb\u4f55 scope \u6269\u5f20\u90fd\u4f1a\u5bfc\u81f4 07-17 \u622a\u6b62\u65e5\u98ce\u9669\u5931\u63a7\n3. **\u4ea7\u54c1\u903b\u8f91**\uff1a\u5728\u7ea6 7 \u5468\u7a97\u53e3\u5185\uff0c\u505a\u597d\u4e00\u4e2a Agent \u7684\u95ed\u73af\u80fd\u529b\uff08\u65b9\u5411\u2192\u8ba1\u5212\u2192\u62c6\u89e3\u2192\u5206\u5de5\u2192\u98ce\u9669\u2192\u91cd\u6392\uff09\u6bd4\u94fa\u5f00\u591a\u4e2a Agent \u66f4\u80fd\u5c55\u793a\u4ea7\u54c1\u4ef7\u503c\n\n\u53ef\u4ee5\u76f4\u63a5\u8f6c\u53d1\uff1a\u8fd9\u6761\u51b3\u7b56\u6709\u8bb0\u5f55\u3001\u6709\u7406\u7531\u3001\u6709\u65f6\u95f4\u7ea6\u675f\u8003\u91cf\u2014\u2014\u4e0d\u662f\u62cd\u8111\u888b\u5426\u51b3\u7684\u3002\u5982\u679c\u63d0\u8bae\u4eba\u8ba4\u4e3a\u60c5\u51b5\u53d8\u4e86\uff08\u6bd4\u5982\u9879\u76ee\u7ed3\u675f\u540e\u60f3\u7ee7\u7eed\u8fed\u4ee3\uff09\uff0c\u53ef\u4ee5\u91cd\u65b0\u53d1\u8d77\u63d0\u6848\u8ba8\u8bba\uff0c\u4f46\u9700\u8981\u9488\u5bf9\u8fd9\u4e09\u6761\u7406\u7531\u7ed9\u51fa\u65b0\u7684\u8bba\u636e\u3002",
            created_at=datetime(2026, 7, 14, 21, 15, 40, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-c5", conversation_id=conv.id, role="user",
            content="\u597d\uff0c\u8fd9\u4e2a\u56de\u7b54\u6211\u76f4\u63a5\u7528\u4e86\u3002\u6700\u540e\u786e\u8ba4\u4e00\u4e2a\u4e8b\uff1a\u4f60\u521a\u624d\u63a8\u8350\u5206\u5de5\u7684\u65f6\u5019\u628a Agent \u8c03\u8bd5\u4efb\u52a1\u6392\u5728\u4e86\u767d\u5929\u2014\u2014\u662f\u56e0\u4e3a\u8003\u8651\u5230\u5c0f\u8d75\u665a\u4e0a\u4e0d\u5728\u7ebf\u5417\uff1f\u8fd9\u4e2a\u4fe1\u606f\u6211\u8bb0\u5f97\u53ea\u6709\u6211\u548c\u5c0f\u8d75\u80fd\u770b\u5230\uff0c\u5176\u4ed6\u6210\u5458\u95ee\u4f60\u5206\u5de5\u5efa\u8bae\u7684\u65f6\u5019\u4f60\u4e5f\u4f1a\u53c2\u8003\u5b83\u5417\uff1f",
            created_at=datetime(2026, 7, 14, 21, 18, 0, tzinfo=timezone.utc),
        ),
        AgentMessage(
            id="demo-msg-c6", conversation_id=conv.id, role="assistant",
            content="\u662f\u7684\uff0c\u6392\u5728\u767d\u5929\u5c31\u662f\u56e0\u4e3a\u90a3\u6761\u7ea6\u675f\u8bb0\u5f55\uff08member_constraint\uff1a\u5c0f\u8d75\u665a\u4e0a 10 \u70b9\u540e\u4e0d\u5728\u7ebf\uff0c\u5982\u9700\u665a\u95f4\u957f\u63a8\u7406\u7531\u5c0f\u6797\u8865\u4f4d\uff09\u3002\n\n\u5173\u4e8e\u53ef\u89c1\u6027\u2014\u2014\u5b83\u53ea\u5bf9\u4f60\u548c\u5c0f\u8d75\u751f\u6548\uff0c\u673a\u5236\u662f\u8fd9\u6837\u7684\uff1a\n\n1. \u6bcf\u6b21\u6210\u5458\u53d1\u8d77 Agent \u5bf9\u8bdd\u65f6\uff0c\u540e\u7aef\u6309\u53d1\u8d77\u4eba\u7684\u8eab\u4efd\uff08viewer_user_id\uff09\u68c0\u7d22\u8bb0\u5fc6\n2. \u90a3\u6761\u7ea6\u675f\u8bb0\u5f55\u7684\u53ef\u89c1\u6027\u662f subject_and_owner\u2014\u2014\u53ea\u6709\u5c0f\u8d75\u672c\u4eba\u548c\u9879\u76ee\u8d1f\u8d23\u4eba\u80fd\u901a\u8fc7\u68c0\u7d22\u62ff\u5230\n3. \u5982\u679c\u5c0f\u738b\u95ee\u6211\u5206\u5de5\u5efa\u8bae\uff0c\u68c0\u7d22\u9636\u6bb5\u5c31\u4f1a\u8fc7\u6ee4\u6389\u8fd9\u6761\u2014\u2014\u5b83\u4e0d\u4f1a\u8fdb\u5165\u6211\u7684\u4e0a\u4e0b\u6587\uff0c\u6211\u7684\u56de\u7b54\u91cc\u4e5f\u4e0d\u4f1a\u51fa\u73b0\u201c\u5c0f\u8d75\u665a\u4e0a\u4e0d\u5728\u7ebf\u201d\u8fd9\u53e5\u8bdd\n\n\u4f60\u53ef\u4ee5\u9a8c\u8bc1\uff1a\u5207\u6362\u5230\u5c0f\u738b\u8eab\u4efd\u540e\u6253\u5f00\u9879\u76ee\u8bb0\u5fc6\u9762\u677f\uff0c\u53ea\u80fd\u770b\u5230 6 \u6761\uff08\u5c11\u4e86\u90a3\u6761\u7ea6\u675f\uff09\u3002\u4e0d\u8fc7\u6ce8\u610f\uff1a\u5373\u4f7f\u5176\u4ed6\u6210\u5458\u770b\u4e0d\u5230\u539f\u59cb\u7ea6\u675f\uff0c\u6211\u7ed9\u51fa\u7684\u5206\u5de5\u5efa\u8bae\u4ecd\u7136\u4f1a\u907f\u5f00\u5c0f\u8d75\u7684\u665a\u95f4\u65f6\u6bb5\u2014\u2014\u56e0\u4e3a\u5efa\u8bae\u662f\u4ee5\u4f60\uff08\u8d1f\u8d23\u4eba\uff09\u786e\u8ba4\u8fc7\u7684\u5206\u5de5\u63d0\u6848\u4e3a\u57fa\u7840\u7684\uff0c\u7ea6\u675f\u5df2\u7ecf\u5728\u90a3\u4e00\u6b65\u88ab\u8003\u8651\u8fdb\u53bb\u4e86\u3002",
            created_at=datetime(2026, 7, 14, 21, 18, 40, tzinfo=timezone.utc),
        ),
    ]
    for m in msgs:
        session.add(m)


# ── Helper: FTS5 indexing for seeded memories ──────────────────────────
_logger = logging.getLogger(__name__)


def _index_memories(session: Session, memories: list[ProjectMemory]) -> None:
    """Best-effort FTS5 indexing for seeded memories.

    Normal path (memory_service._persist_candidates) indexes via
    MemoryRetriever.index_memory() when writing each record.  Seed data
    bypasses that path, so we index here after commit.

    On success, updates the ProjectMemorySync record to synced.
    On failure, updates to failed with a safe error prefix (same
    semantics as the service layer).
    """
    try:
        from app.agent.memory.retriever import MemoryRetriever
        conn = session.connection()
        retriever = MemoryRetriever(conn)
        for m in memories:
            sync = session.get(ProjectMemorySync, m.id)
            if sync is None:
                continue
            try:
                retriever.index_memory(m)
                sync.sync_status = "synced"
                sync.last_synced_at = T_NOW
                sync.last_error = None
            except Exception as exc:
                sync.sync_status = "failed"
                sync.last_error = _truncate_safe_error(str(exc))
                _logger.warning("FTS5 seed index failed for %s: %s", m.id, exc)
    except Exception as exc:
        _logger.warning("FTS5 seed indexing unavailable, memories will use sqlite_field fallback: %s", exc)
        # Mark all as failed
        for m in memories:
            sync = session.get(ProjectMemorySync, m.id)
            if sync is not None:
                sync.sync_status = "failed"
                sync.last_error = _truncate_safe_error(str(exc))


def _truncate_safe_error(error_text: str, max_len: int = 200) -> str:
    """Keep only error type prefix, same semantics as memory_service."""
    error_type = str(error_text).strip().split(maxsplit=1)[0].split(":", 1)[0]
    safe = "".join(ch for ch in error_type if ch.isascii() and (ch.isalnum() or ch in "._-"))
    return f"{safe or 'MemoryIndexError'}: FTS5 seed indexing failed"[:max_len]
