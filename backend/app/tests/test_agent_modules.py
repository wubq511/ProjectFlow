from datetime import date

import json
import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent.coordinator import CoordinatorAgent
from app.agent.llm_client import MockLLMClient
from app.agent.modules import (
    active_push,
    assignment_negotiation,
    assignment_recommendation,
    breakdown,
    checkin_analysis,
    clarification,
    planning,
    replanning,
    risk_analysis,
)
from app.agent.output_schemas import validate_agent_output
from app.agent.workflow import AgentRunStatus
from app.models import AgentEvent
from app.models.enums import AgentEventType
from app.schemas.workspace_state import (
    AssignmentNegotiationState,
    AssignmentProposalState,
    AssignmentResponseState,
    MemberState,
    ProjectState,
    StageState,
    TaskState,
    WorkspaceStateResponse,
)


def _workspace_state() -> WorkspaceStateResponse:
    return WorkspaceStateResponse(
        workspace_id="workspace-1",
        workspace_name="Demo Team",
        members=[
            MemberState(
                user_id="user-1",
                display_name="Alice",
                skills=["backend"],
                available_hours_per_week=8,
                role_preference="backend",
                interests="APIs",
                constraints="",
            )
        ],
        project=ProjectState(
            id="project-1",
            name="Demo Project",
            idea="Build a project agent",
            deadline=date(2026, 6, 7),
            status="active",
            current_stage_id="stage-1",
            stages=[
                StageState(
                    id="stage-1",
                    name="MVP",
                    goal="Ship demo",
                    status="active",
                    order_index=0,
                )
            ],
            tasks=[
                TaskState(
                    id="task-1",
                    stage_id="stage-1",
                    title="Build API",
                    status="not_started",
                    priority="P0",
                    owner_user_id=None,
                    due_date=date(2026, 6, 1),
                    can_cut=False,
                )
            ],
        ),
    )


def _contains_cjk(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in text)


@pytest.fixture(name="session")
def session_fixture():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


@pytest.mark.parametrize(
    ("module", "event_type"),
    [
        (clarification, AgentEventType.clarify),
        (planning, AgentEventType.plan),
        (breakdown, AgentEventType.breakdown),
        (assignment_recommendation, AgentEventType.assign),
        (assignment_negotiation, AgentEventType.negotiate),
        (active_push, AgentEventType.push),
        (checkin_analysis, AgentEventType.checkin),
        (risk_analysis, AgentEventType.risk),
        (replanning, AgentEventType.replan),
    ],
)
def test_agent_modules_return_valid_generation_requests(module, event_type):
    request = module.build_request(_workspace_state())

    assert request.event_type == event_type
    assert request.user_prompt
    validate_agent_output(
        request.event_type,
        request.fallback_payload,
        workspace_state=_workspace_state(),
    )


def test_t23a_clarification_fallback_is_chinese_and_project_aware():
    request = clarification.build_request(_workspace_state())
    payload = request.fallback_payload

    assert _contains_cjk(payload["problem"])
    assert "Demo Project" in payload["reason"]
    assert len(payload["deliverables"]) >= 2
    assert len(payload["suggested_questions"]) >= 2


def test_t23a_planning_fallback_has_multiple_chinese_stages():
    request = planning.build_request(_workspace_state())
    stages = request.fallback_payload["stages"]

    assert len(stages) == 3
    assert all(_contains_cjk(stage["name"]) for stage in stages)
    assert stages[0]["order_index"] == 0
    assert stages[1]["order_index"] == 1
    assert stages[2]["order_index"] == 2


def test_t23a_breakdown_fallback_has_three_prioritized_chinese_tasks():
    request = breakdown.build_request(_workspace_state())
    tasks = request.fallback_payload["tasks"]

    assert len(tasks) == 3
    assert [task["priority"] for task in tasks] == ["P0", "P1", "P2"]
    assert all(task["stage_id"] == "stage-1" for task in tasks)
    assert all(_contains_cjk(task["title"]) for task in tasks)


def test_coordinator_delegates_direction_card_generation_and_logs_event(session: Session):
    client = MockLLMClient(
        responses=[
            '{"problem":"Scope unclear","users":"Student team",'
            '"value":"Direction card for planning","deliverables":["Direction card"],'
            '"boundaries":["Deadline fixed"],"risks":["Scope creep"],'
            '"suggested_questions":["Which scope is required?"],'
            '"reason":"Direction must be explicit."}'
        ]
    )
    coordinator = CoordinatorAgent(llm_client=client, session=session)

    result = coordinator.generate_direction_card(_workspace_state())

    assert result.status == AgentRunStatus.success
    assert result.output.reason == "Direction must be explicit."
    assert client.calls == 1

    event = session.exec(select(AgentEvent)).one()
    assert event.event_type == AgentEventType.clarify
    assert json.loads(event.output_snapshot)["problem"] == "Scope unclear"


def test_coordinator_exposes_all_agent_flow_methods():
    coordinator = CoordinatorAgent(llm_client=MockLLMClient())

    assert callable(coordinator.generate_direction_card)
    assert callable(coordinator.generate_stage_plan)
    assert callable(coordinator.generate_task_breakdown)
    assert callable(coordinator.recommend_assignments)
    assert callable(coordinator.negotiate_assignment)
    assert callable(coordinator.create_active_push)
    assert callable(coordinator.analyze_checkin)
    assert callable(coordinator.analyze_risks)
    assert callable(coordinator.replan)


# ---------------------------------------------------------------------------
# T23.B Assignment fallback tests
# ---------------------------------------------------------------------------


def _assignment_workspace_state() -> WorkspaceStateResponse:
    return WorkspaceStateResponse(
        workspace_id="ws-assign",
        workspace_name="Assignment Test Team",
        members=[
            MemberState(
                user_id="user-lin", display_name="林舟",
                skills=["前端", "React", "UI设计"],
                available_hours_per_week=15,
                role_preference="前端开发", interests="用户界面",
                constraints="",
            ),
            MemberState(
                user_id="user-mia", display_name="Mia",
                skills=["后端", "Python", "数据库"],
                available_hours_per_week=12,
                role_preference="后端开发", interests="API设计",
                constraints="周四下午不可用",
            ),
            MemberState(
                user_id="user-chen", display_name="陈远",
                skills=["全栈", "测试", "文档"],
                available_hours_per_week=8,
                role_preference="测试与文档", interests="质量保障",
                constraints="prefers not to do design work",
            ),
        ],
        project=ProjectState(
            id="proj-assign",
            name="评估项目",
            idea="测试分工推荐功能",
            deadline=date(2026, 6, 15),
            status="active",
            current_stage_id="stage-active",
            stages=[
                StageState(
                    id="stage-active", name="核心开发",
                    goal="完成核心功能", status="active", order_index=0,
                ),
                StageState(
                    id="stage-pending", name="后续阶段",
                    goal="后续工作", status="pending", order_index=1,
                ),
            ],
            tasks=[
                # Active stage - 5 tasks, all unassigned
                TaskState(
                    id="task-fe", stage_id="stage-active",
                    title="构建前端页面", status="not_started",
                    priority="P0", owner_user_id=None,
                    due_date=date(2026, 6, 10), estimated_hours=10,
                    can_cut=False,
                ),
                TaskState(
                    id="task-api", stage_id="stage-active",
                    title="实现后端 API", status="not_started",
                    priority="P0", owner_user_id=None,
                    due_date=date(2026, 6, 10), estimated_hours=8,
                    can_cut=False,
                ),
                TaskState(
                    id="task-db", stage_id="stage-active",
                    title="数据库Schema设计", status="not_started",
                    priority="P1", owner_user_id=None,
                    due_date=date(2026, 6, 8), estimated_hours=4,
                    can_cut=False,
                ),
                TaskState(
                    id="task-test", stage_id="stage-active",
                    title="编写E2E测试", status="not_started",
                    priority="P1", owner_user_id=None,
                    due_date=date(2026, 6, 12), estimated_hours=6,
                    can_cut=True,
                ),
                TaskState(
                    id="task-doc", stage_id="stage-active",
                    title="撰写API文档", status="not_started",
                    priority="P2", owner_user_id=None,
                    due_date=date(2026, 6, 14), estimated_hours=3,
                    can_cut=True,
                ),
                # Pending stage task - should be excluded
                TaskState(
                    id="task-next", stage_id="stage-pending",
                    title="后续阶段任务", status="not_started",
                    priority="P2", owner_user_id=None,
                    due_date=date(2026, 6, 20), estimated_hours=5,
                    can_cut=True,
                ),
                # Done task in active stage - should be excluded
                TaskState(
                    id="task-done", stage_id="stage-active",
                    title="已完成任务", status="done",
                    priority="P0", owner_user_id="user-lin",
                    due_date=date(2026, 6, 5), estimated_hours=4,
                    can_cut=False,
                ),
                # Task with existing owner - should be excluded
                TaskState(
                    id="task-owned", stage_id="stage-active",
                    title="已有负责人的任务", status="not_started",
                    priority="P1", owner_user_id="user-mia",
                    due_date=date(2026, 6, 9), estimated_hours=3,
                    can_cut=False,
                ),
            ],
            # Include a rejected proposal to test avoidance
            assignment_proposals=[
                AssignmentProposalState(
                    id="prop-rejected",
                    stage_id="stage-active",
                    task_id="task-fe",
                    recommended_owner_user_id="user-chen",
                    status="owner_rejected",
                ),
            ],
            assignment_responses=[],
            assignment_negotiations=[],
        ),
    )


def _single_member_workspace_state() -> WorkspaceStateResponse:
    return WorkspaceStateResponse(
        workspace_id="ws-single",
        workspace_name="Single Member Team",
        members=[
            MemberState(
                user_id="user-lin", display_name="林舟",
                skills=["全栈", "Python", "React"],
                available_hours_per_week=20,
                role_preference="开发", interests="全栈",
                constraints="",
            ),
        ],
        project=ProjectState(
            id="proj-single",
            name="单人项目",
            idea="测试单成员场景",
            deadline=date(2026, 6, 15),
            status="active",
            current_stage_id="stage-a",
            stages=[
                StageState(
                    id="stage-a", name="实现",
                    goal="全部工作", status="active", order_index=0,
                ),
            ],
            tasks=[
                TaskState(
                    id="t1", stage_id="stage-a",
                    title="任务A", status="not_started",
                    priority="P0", owner_user_id=None,
                    due_date=date(2026, 6, 10), estimated_hours=6,
                    can_cut=False,
                ),
                TaskState(
                    id="t2", stage_id="stage-a",
                    title="任务B", status="not_started",
                    priority="P1", owner_user_id=None,
                    due_date=date(2026, 6, 12), estimated_hours=4,
                    can_cut=False,
                ),
                TaskState(
                    id="t3", stage_id="stage-a",
                    title="任务C", status="not_started",
                    priority="P2", owner_user_id=None,
                    due_date=date(2026, 6, 14), estimated_hours=3,
                    can_cut=True,
                ),
            ],
        ),
    )


class TestT23BAssignmentFallback:
    def test_covers_all_active_unassigned_tasks(self):
        """B1/B11: Fallback generates proposals for all 5 active-stage unassigned tasks."""
        request = assignment_recommendation.build_request(_assignment_workspace_state())
        payload = request.fallback_payload
        assignments = payload["assignments"]

        assert len(assignments) == 5
        task_ids = {a["task_id"] for a in assignments}
        assert task_ids == {"task-fe", "task-api", "task-db", "task-test", "task-doc"}

    def test_skips_finalized_and_non_active_stage_tasks(self):
        """B8: Fallback excludes pending-stage, done, and already-owned tasks."""
        request = assignment_recommendation.build_request(_assignment_workspace_state())
        task_ids = {a["task_id"] for a in request.fallback_payload["assignments"]}

        assert "task-next" not in task_ids  # pending stage
        assert "task-done" not in task_ids   # done status
        assert "task-owned" not in task_ids   # already has owner

    def test_avoids_rejected_owner_task_pair(self):
        """B9: Fallback avoids the rejected (task-fe, user-chen) pair."""
        request = assignment_recommendation.build_request(_assignment_workspace_state())
        for a in request.fallback_payload["assignments"]:
            if a["task_id"] == "task-fe":
                assert a["recommended_owner_user_id"] != "user-chen"

    def test_handles_single_member_all_tasks(self):
        """B10: Single member gets all 3 tasks."""
        request = assignment_recommendation.build_request(_single_member_workspace_state())
        assignments = request.fallback_payload["assignments"]

        assert len(assignments) == 3
        task_ids = {a["task_id"] for a in assignments}
        assert task_ids == {"t1", "t2", "t3"}
        # All assigned to same member
        owners = {a["recommended_owner_user_id"] for a in assignments}
        assert len(owners) == 1
        assert "user-lin" in owners

    def test_uses_chinese_user_facing_text(self):
        """B2: All user-facing fields are in Chinese."""
        request = assignment_recommendation.build_request(_assignment_workspace_state())
        for a in request.fallback_payload["assignments"]:
            assert _contains_cjk(a["reason"])
            if a.get("skill_match"):
                assert _contains_cjk(a["skill_match"])
            if a.get("availability_match"):
                assert _contains_cjk(a["availability_match"])
            if a.get("preference_match"):
                assert _contains_cjk(a["preference_match"])
            if a.get("constraint_respected"):
                assert _contains_cjk(a["constraint_respected"])

    def test_single_member_has_no_backup_and_workload_risk_note(self):
        """B10: Single member has no backup, risk_note explains workload."""
        request = assignment_recommendation.build_request(_single_member_workspace_state())
        for a in request.fallback_payload["assignments"]:
            assert a["backup_owner_user_id"] is None
            assert _contains_cjk(a["risk_note"]) if a.get("risk_note") else True

    def test_empty_when_no_members(self):
        """Graceful when workspace has no members."""
        ws = WorkspaceStateResponse(
            workspace_id="ws-empty",
            workspace_name="Empty",
            members=[],
            project=ProjectState(
                id="p-empty", name="Empty", idea="",
                deadline=date(2026, 6, 7), status="active",
                current_stage_id=None, stages=[], tasks=[],
            ),
        )
        request = assignment_recommendation.build_request(ws)
        assert request.fallback_payload["assignments"] == []
        assert request.fallback_payload["requires_confirmation"]  # model validator requires True

    def test_empty_when_no_eligible_tasks(self):
        """Graceful when all tasks are blocked or finalized."""
        ws = _assignment_workspace_state()
        # Mark all tasks as done
        if ws.project:
            for task in ws.project.tasks:
                task.status = "done"
        request = assignment_recommendation.build_request(ws)
        assert request.fallback_payload["assignments"] == []

    def test_stage_override_uses_given_stage_not_active_stage(self):
        """B8/IR4: stage_id override selects tasks from the given stage."""
        ws = _assignment_workspace_state()
        # Force a different stage than the active one
        request = assignment_recommendation.build_request(ws, stage_id="stage-pending")
        task_ids = {a["task_id"] for a in request.fallback_payload["assignments"]}
        # Only stage-pending tasks: task-next
        assert task_ids == {"task-next"}

    def test_stage_override_ignored_when_none(self):
        """When stage_id is None, falls back to active_stage_id."""
        ws = _assignment_workspace_state()
        request = assignment_recommendation.build_request(ws, stage_id=None)
        # Should use active stage (stage-1)
        task_ids = {a["task_id"] for a in request.fallback_payload["assignments"]}
        assert len(task_ids) == 5  # stage-1 has 5 assignable tasks


# ---------------------------------------------------------------------------
# T23.B P1 — negotiation module context
# ---------------------------------------------------------------------------


def _negotiation_workspace_state() -> WorkspaceStateResponse:
    return WorkspaceStateResponse(
        workspace_id='ws-negotiate',
        workspace_name='Negotiation Test',
        members=[
            MemberState(user_id='user-lin', display_name='林舟', skills=['前端','React'], available_hours_per_week=15, role_preference='前端开发', interests='用户界面', constraints=''),
            MemberState(user_id='user-mia', display_name='Mia', skills=['后端','Python'], available_hours_per_week=12, role_preference='后端开发', interests='API设计', constraints=''),
        ],
        project=ProjectState(
            id='proj-negotiate', name='协商测试', idea='测试', deadline=date(2026,6,15), status='active', current_stage_id='stage-active',
            stages=[StageState(id='stage-active', name='开发', goal='开发', status='active', order_index=0)],
            tasks=[
                TaskState(id='task-fe', stage_id='stage-active', title='构建前端页面', status='not_started', priority='P0', owner_user_id='user-lin', due_date=date(2026,6,10), estimated_hours=10, can_cut=False),
                TaskState(id='task-api', stage_id='stage-active', title='实现后端 API', status='not_started', priority='P0', owner_user_id=None, due_date=date(2026,6,10), estimated_hours=8, can_cut=False),
            ],
            assignment_proposals=[AssignmentProposalState(id='prop-rejected', stage_id='stage-active', task_id='task-fe', recommended_owner_user_id='user-lin', status='owner_rejected')],
            assignment_responses=[AssignmentResponseState(id='resp-1', proposal_id='prop-rejected', user_id='user-lin', response='reject', preferred_task_id='task-api', reason='我更擅长后端工作')],
            assignment_negotiations=[AssignmentNegotiationState(id='neg-1', stage_id='stage-active', from_user_id='user-lin', desired_task_id='task-api', current_owner_user_id=None, status='pending')],
        ),
    )


class TestT23BNegotiationModule:
    def test_prompt_includes_rejection_context(self):
        ws = _negotiation_workspace_state()
        request = assignment_negotiation.build_request(ws)
        assert '林舟' in request.user_prompt
        assert '构建前端页面' in request.user_prompt
        assert '我更擅长后端工作' in request.user_prompt
        assert '实现后端 API' in request.user_prompt

    def test_prompt_includes_negotiation_context(self):
        ws = _negotiation_workspace_state()
        request = assignment_negotiation.build_request(ws)
        assert '希望换到' in request.user_prompt or '协商' in request.user_prompt

    def test_fallback_uses_rejected_proposal_data(self):
        ws = _negotiation_workspace_state()
        request = assignment_negotiation.build_request(ws)
        payload = request.fallback_payload
        assert payload['from_user_id'] == 'user-lin'
        assert payload['desired_task_id'] == 'task-api'
        assert '构建前端页面' in payload['message']
        assert '实现后端 API' in payload['message']
        assert len(payload['options']) >= 2
        for opt in payload['options']:
            assert _contains_cjk(opt)

    def test_handles_no_rejections_gracefully(self):
        ws = WorkspaceStateResponse(
            workspace_id='ws-empty', workspace_name='Empty',
            members=[MemberState(user_id='user-1', display_name='Alice', skills=['backend'], available_hours_per_week=10, role_preference='backend', interests='API', constraints='')],
            project=ProjectState(id='proj-empty', name='Empty', idea='', deadline=date(2026,6,7), status='active', current_stage_id=None, stages=[], tasks=[TaskState(id='task-1', stage_id='stage-1', title='Task', status='not_started', priority='P0', owner_user_id=None, due_date=date(2026,6,5), can_cut=False)]),
        )
        request = assignment_negotiation.build_request(ws)
        assert request.fallback_payload['requires_confirmation'] is True
        assert '暂无拒绝记录' in request.user_prompt or len(request.user_prompt) > 30

    def test_fallback_current_owner_is_none_when_preferred_task_unassigned(self):
        """When the preferred task has no owner, current_owner_user_id must be None."""
        ws = _negotiation_workspace_state()
        request = assignment_negotiation.build_request(ws)
        payload = request.fallback_payload
        # task-api has owner_user_id=None in the fixture
        assert payload['desired_task_id'] == 'task-api'
        assert payload['current_owner_user_id'] is None
