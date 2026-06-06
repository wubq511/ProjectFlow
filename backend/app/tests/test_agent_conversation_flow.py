import json

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select

from app.agent.llm_client import MockLLMClient
from app.models import AgentEvent
from app.models.agent_conversation import AgentConversation, AgentMessage, AgentRun
from app.services.agent_conversation_service import (
    get_or_create_project_conversation,
    process_conversation_message,
)
from app.seed.demo_projectflow import seed_demo_data


def _create_project_fixture(client: TestClient):
    owner = client.post("/api/users", json={"display_name": "Agent Owner"}).json()
    workspace = client.post(
        "/api/workspaces",
        json={"name": "Agent Conversation Workspace"},
        params={"owner_user_id": owner["id"]},
    ).json()
    project = client.post(
        "/api/projects",
        json={
            "workspace_id": workspace["id"],
            "name": "Conversation Project",
            "idea": "Build an agent workflow",
            "deadline": "2026-06-20",
            "deliverables": "Working demo",
            "created_by": owner["id"],
        },
    ).json()
    return owner, workspace, project


def _session_fixture():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        json_serializer=json.dumps,
        json_deserializer=json.loads,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def test_project_conversation_endpoint_gets_or_creates_active_conversation(client: TestClient):
    _owner, _workspace, project = _create_project_fixture(client)

    response = client.get(f"/api/projects/{project['id']}/agent-conversation")

    assert response.status_code == 200
    payload = response.json()
    assert payload["project_id"] == project["id"]
    assert payload["status"] == "active"
    assert payload["messages"] == []
    assert payload["current_focus"]


def test_conversation_blocks_breakdown_before_stages_and_records_messages(client: TestClient):
    _owner, _workspace, project = _create_project_fixture(client)
    client.patch(
        f"/api/projects/{project['id']}",
        json={
            "direction_card": {
                "problem": "方向已确认",
                "users": "学生团队",
                "value": "推进项目",
                "deliverables": ["Demo"],
                "boundaries": ["MVP"],
                "risks": ["时间紧"],
                "suggested_questions": ["是否开始规划？"],
                "reason": "测试需要已确认方向",
            }
        },
    )
    conversation = client.get(f"/api/projects/{project['id']}/agent-conversation").json()

    response = client.post(
        f"/api/agent/conversations/{conversation['id']}/messages",
        json={"content": "直接帮我拆解任务"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["run"] is None
    assert payload["assistant_message"]["role"] == "assistant"
    assert "阶段计划" in payload["assistant_message"]["content"]
    assert payload["next_suggestions"]


def test_service_uses_llm_turn_plan_and_passes_user_instruction_to_agent_flow(client: TestClient):
    owner, workspace, project = _create_project_fixture(client)
    direction = {
        "problem": "项目方向已明确",
        "users": "学生项目团队",
        "value": "按三周训练营节奏推进",
        "deliverables": ["演示 Demo"],
        "boundaries": ["先完成 MVP"],
        "risks": ["时间紧"],
        "suggested_questions": ["是否优先演示？"],
        "reason": "测试需要已确认方向卡",
    }
    client.patch(f"/api/projects/{project['id']}", json={"direction_card": direction})

    engine = _session_fixture()
    with Session(engine) as session:
        # Re-create the API fixture records in this isolated service session.
        from app.models import Project, User, Workspace, WorkspaceMembership

        session.add(User(id=owner["id"], display_name=owner["display_name"]))
        session.add(Workspace(id=workspace["id"], name=workspace["name"], owner_user_id=owner["id"]))
        session.add(WorkspaceMembership(workspace_id=workspace["id"], user_id=owner["id"], role="owner"))
        session.add(
            Project(
                id=project["id"],
                workspace_id=workspace["id"],
                name=project["name"],
                idea=project["idea"],
                deadline=project["deadline"],
                deliverables=project["deliverables"],
                created_by=owner["id"],
                direction_card=json.dumps(direction, ensure_ascii=False),
            )
        )
        session.commit()

        conversation = get_or_create_project_conversation(session, project["id"])
        llm_client = MockLLMClient(
            responses=[
                json.dumps(
                    {
                        "response_type": "run_module",
                        "selected_module": "plan",
                        "user_instruction": "把阶段计划压缩成 3 周，优先演示闭环",
                        "rationale": "用户明确要求重新规划阶段",
                        "required_inputs": [],
                        "expected_artifact": "阶段计划提案",
                        "risk_level": "medium",
                        "requires_confirmation": True,
                    },
                    ensure_ascii=False,
                ),
                "{}",
            ]
        )

        result = process_conversation_message(
            session,
            conversation.id,
            "把阶段计划压缩成 3 周，优先演示闭环",
            llm_client=llm_client,
        )

        assert result.run is not None
        assert result.run.selected_module == "plan"
        assert result.run.user_instruction == "把阶段计划压缩成 3 周，优先演示闭环"
        assert result.run.proposal_id is not None

        event = session.exec(select(AgentEvent)).one()
        input_snapshot = json.loads(event.input_snapshot)
        assert input_snapshot["user_instruction"] == "把阶段计划压缩成 3 周，优先演示闭环"

        messages = session.exec(select(AgentMessage)).all()
        assert [message.role for message in messages] == ["user", "assistant"]
        assert messages[-1].linked_proposal_id == result.run.proposal_id

        runs = session.exec(select(AgentRun)).all()
        assert runs[0].status == "proposal_created"


def test_service_accepts_llm_planner_alias_fields_for_module_execution():
    engine = _session_fixture()
    with Session(engine) as session:
        seed_demo_data(session)
        conversation = get_or_create_project_conversation(session, "demo-project-001")
        llm_client = MockLLMClient(
            responses=[
                json.dumps(
                    {
                        "type": "run_module",
                        "module": "risk",
                        "parameters": {},
                    },
                    ensure_ascii=False,
                ),
                "{}",
                "{}",
            ]
        )

        result = process_conversation_message(
            session,
            conversation.id,
            "分析当前风险",
            llm_client=llm_client,
        )

        assert result.run is not None
        assert result.turn_plan is not None
        assert result.turn_plan.response_type == "run_module"
        assert result.turn_plan.selected_module == "risk"
        assert result.run.selected_module == "risk"
        assert result.run.user_instruction == "分析当前风险"
        assert "风险" in result.assistant_message.content


def test_conversation_turn_returns_structured_suggestions_and_proposal_artifact():
    engine = _session_fixture()
    with Session(engine) as session:
        seed_demo_data(session)
        conversation = get_or_create_project_conversation(session, "demo-project-001")
        llm_client = MockLLMClient(
            responses=[
                json.dumps(
                    {
                        "response_type": "run_module",
                        "selected_module": "replan",
                        "user_instruction": "根据签到调整计划",
                        "rationale": "签到显示后端阻塞，需要生成计划调整草案。",
                        "required_inputs": [],
                        "expected_artifact": "计划调整草案",
                        "risk_level": "medium",
                        "requires_confirmation": True,
                    },
                    ensure_ascii=False,
                ),
                "{}",
            ]
        )

        result = process_conversation_message(
            session,
            conversation.id,
            "根据签到调整计划",
            llm_client=llm_client,
        )

        assert result.run is not None
        assert result.run.proposal_id is not None
        assert result.suggestions
        assert result.suggestions[0].label
        assert result.suggestions[0].user_instruction
        assert result.suggestions[0].priority in {"primary", "secondary"}
        assert result.artifacts
        artifact = result.artifacts[0]
        assert artifact.type == "proposal"
        assert artifact.status == "pending_confirmation"
        assert artifact.linked_entity_ids == [result.run.proposal_id]
        assert "计划" in artifact.title or "调整" in artifact.title
        assert artifact.summary
        assert artifact.rationale
        assert artifact.impact
        assert result.assistant_message.structured_payload["artifacts"][0]["id"] == artifact.id
        assert result.assistant_message.structured_payload["suggestions"][0]["label"] == result.suggestions[0].label


def test_conversation_turn_builds_risk_artifact_from_flow_result():
    engine = _session_fixture()
    with Session(engine) as session:
        seed_demo_data(session)
        conversation = get_or_create_project_conversation(session, "demo-project-001")
        llm_client = MockLLMClient(
            responses=[
                json.dumps(
                    {
                        "response_type": "run_module",
                        "selected_module": "risk",
                        "user_instruction": "分析当前风险",
                        "rationale": "用户要求分析项目风险",
                        "required_inputs": [],
                        "expected_artifact": "风险分析",
                        "risk_level": "medium",
                        "requires_confirmation": False,
                    },
                    ensure_ascii=False,
                ),
                json.dumps(
                    {
                        "risks": [
                            {
                                "type": "deadline",
                                "severity": "medium",
                                "title": "演示日期临近",
                                "description": "距离演示只剩两周，集成测试尚未开始。",
                                "evidence": ["集成测试任务状态为未开始"],
                                "recommendation": "优先完成核心链路集成测试。",
                            }
                        ],
                        "reason": "基于任务状态和时间线分析得出。",
                    },
                    ensure_ascii=False,
                ),
            ]
        )

        result = process_conversation_message(
            session,
            conversation.id,
            "分析当前风险",
            llm_client=llm_client,
        )

        assert result.run is not None
        assert result.run.selected_module == "risk"
        assert len(result.artifacts) == 1
        artifact = result.artifacts[0]
        assert artifact.type == "risk_analysis"
        assert artifact.status == "draft"
        assert artifact.linked_entity_ids
        assert artifact.summary
        assert artifact.rationale
        assert artifact.impact
        assert result.assistant_message.structured_payload["artifacts"][0]["id"] == artifact.id
        assert result.assistant_message.structured_payload["artifacts"][0]["type"] == "risk_analysis"


def test_conversation_turn_builds_push_artifact_from_flow_result():
    engine = _session_fixture()
    with Session(engine) as session:
        seed_demo_data(session)
        conversation = get_or_create_project_conversation(session, "demo-project-001")
        llm_client = MockLLMClient(
            responses=[
                json.dumps(
                    {
                        "response_type": "run_module",
                        "selected_module": "push",
                        "user_instruction": "生成下一步行动卡",
                        "rationale": "用户要求生成推进行动卡",
                        "required_inputs": [],
                        "expected_artifact": "下一步行动卡",
                        "risk_level": "low",
                        "requires_confirmation": False,
                    },
                    ensure_ascii=False,
                ),
                json.dumps(
                    {
                        "action_cards": [
                            {
                                "type": "team_next_step",
                                "title": "推进前端页面搭建",
                                "content": "优先完成工作台页面骨架。",
                                "reason": "前端页面是演示闭环的关键路径。",
                                "goal": "完成工作台页面骨架",
                                "start_suggestion": "从三栏布局开始搭建",
                                "completion_standard": "页面可渲染且路由可跳转",
                            }
                        ],
                        "reason": "基于当前任务状态推荐下一步行动。",
                    },
                    ensure_ascii=False,
                ),
            ]
        )

        result = process_conversation_message(
            session,
            conversation.id,
            "生成下一步行动卡",
            llm_client=llm_client,
        )

        assert result.run is not None
        assert result.run.selected_module == "push"
        assert len(result.artifacts) == 1
        artifact = result.artifacts[0]
        assert artifact.type == "action_card"
        assert artifact.status == "draft"
        assert artifact.linked_entity_ids
        assert artifact.summary
        assert artifact.rationale
        assert artifact.impact
        assert result.assistant_message.structured_payload["artifacts"][0]["id"] == artifact.id
        assert result.assistant_message.structured_payload["artifacts"][0]["type"] == "action_card"


def test_service_uses_llm_planner_content_for_direct_answer():
    engine = _session_fixture()
    with Session(engine) as session:
        seed_demo_data(session)
        conversation = get_or_create_project_conversation(session, "demo-project-001")
        llm_client = MockLLMClient(
            responses=[
                json.dumps(
                    {
                        "turn_type": "clarify",
                        "content": "你好！你想让我做什么？比如分析风险、生成行动卡，或者聊聊项目进度？",
                    },
                    ensure_ascii=False,
                )
            ]
        )

        result = process_conversation_message(
            session,
            conversation.id,
            "hi",
            llm_client=llm_client,
        )

        assert result.run is None
        assert result.assistant_message.content == "你好！你想让我做什么？比如分析风险、生成行动卡，或者聊聊项目进度？"
        assert result.turn_plan is not None
        assert result.turn_plan.response_type == "answer"


def test_service_direct_answer_never_exposes_parser_diagnostics():
    engine = _session_fixture()
    with Session(engine) as session:
        seed_demo_data(session)
        conversation = get_or_create_project_conversation(session, "demo-project-001")
        llm_client = MockLLMClient(responses=["{}"])

        result = process_conversation_message(
            session,
            conversation.id,
            "hi",
            llm_client=llm_client,
        )

        assert result.run is None
        assert "LLM planner" not in result.assistant_message.content
        assert "可以" in result.assistant_message.content


def test_conversation_models_persist_linked_artifacts():
    engine = _session_fixture()
    with Session(engine) as session:
        conversation = AgentConversation(
            workspace_id="workspace-1",
            project_id="project-1",
            current_focus="方向澄清",
        )
        session.add(conversation)
        session.flush()

        message = AgentMessage(
            conversation_id=conversation.id,
            role="assistant",
            content="阶段计划已生成，等待确认。",
            linked_event_id="event-1",
            linked_proposal_id="proposal-1",
        )
        run = AgentRun(
            conversation_id=conversation.id,
            project_id="project-1",
            user_instruction="按三周倒排",
            selected_module="plan",
            status="proposal_created",
            model="mock",
            attempts=2,
            verifier_status="passed",
            agent_event_id="event-1",
            proposal_id="proposal-1",
        )
        session.add(message)
        session.add(run)
        session.commit()

        saved_message = session.exec(select(AgentMessage)).one()
        saved_run = session.exec(select(AgentRun)).one()

        assert saved_message.linked_event_id == "event-1"
        assert saved_message.linked_proposal_id == "proposal-1"
        assert saved_run.user_instruction == "按三周倒排"


def test_structured_suggestions_map_action_labels_to_explicit_executable_instructions():
    from app.services.agent_conversation_service import _structured_suggestions

    labels = ["生成下一步行动卡", "分析当前风险", "根据签到调整计划"]
    suggestions = _structured_suggestions(labels)

    for suggestion in suggestions:
        assert suggestion.user_instruction != suggestion.label, (
            f"user_instruction should differ from display label for '{suggestion.label}'"
        )
        assert "replan" in suggestion.user_instruction or "push" in suggestion.user_instruction or "risk" in suggestion.user_instruction, (
            f"user_instruction for '{suggestion.label}' should contain an explicit module keyword, got: {suggestion.user_instruction}"
        )

    replan_suggestion = next(s for s in suggestions if s.label == "根据签到调整计划")
    assert "replan" in replan_suggestion.user_instruction
    assert "根据签到调整计划" in replan_suggestion.user_instruction

    push_suggestion = next(s for s in suggestions if s.label == "生成下一步行动卡")
    assert "push" in push_suggestion.user_instruction

    risk_suggestion = next(s for s in suggestions if s.label == "分析当前风险")
    assert "risk" in risk_suggestion.user_instruction


def test_planner_prompt_includes_quick_reply_action_mapping_examples():
    from app.services.agent_conversation_service import _plan_turn
    from app.models.agent_conversation import AgentConversation

    recorded_messages: list = []

    class RecordingLLM:
        model = "recording-test"

        def complete(self, messages, max_tokens=1200):
            recorded_messages.extend(messages)
            return json.dumps(
                {
                    "response_type": "run_module",
                    "selected_module": "replan",
                    "user_instruction": "根据签到结果调整项目计划",
                    "rationale": "用户要求根据签到调整计划",
                    "required_inputs": [],
                    "expected_artifact": "计划调整草案",
                    "risk_level": "medium",
                    "requires_confirmation": True,
                },
                ensure_ascii=False,
            )

    engine = _session_fixture()
    with Session(engine) as session:
        seed_demo_data(session)
        conversation = get_or_create_project_conversation(session, "demo-project-001")
        from app.services.agent_conversation_service import get_workspace_state

        workspace_state = get_workspace_state(session, conversation.workspace_id, project_id=conversation.project_id)

        plan = _plan_turn(
            RecordingLLM(),
            content="根据签到调整计划",
            conversation=conversation,
            workspace_state=workspace_state,
            recent_messages=[],
        )

        assert plan.response_type == "run_module"
        assert plan.selected_module == "replan"

        system_msg = recorded_messages[0]["content"]
        assert "run_module" in system_msg
        assert "replan" in system_msg
        assert "根据签到调整计划" in system_msg


def test_get_or_create_project_conversation_reuses_existing_record(client: TestClient):
    owner, workspace, project = _create_project_fixture(client)
    engine = _session_fixture()
    with Session(engine) as session:
        from app.models import Project, User, Workspace, WorkspaceMembership

        session.add(User(id=owner["id"], display_name=owner["display_name"]))
        session.add(Workspace(id=workspace["id"], name=workspace["name"], owner_user_id=owner["id"]))
        session.add(WorkspaceMembership(workspace_id=workspace["id"], user_id=owner["id"], role="owner"))
        session.add(
            Project(
                id=project["id"],
                workspace_id=workspace["id"],
                name=project["name"],
                idea=project["idea"],
                deadline=project["deadline"],
                deliverables=project["deliverables"],
                created_by=owner["id"],
            )
        )
        session.commit()

        first = get_or_create_project_conversation(session, project["id"])
        second = get_or_create_project_conversation(session, project["id"])

        assert first.id == second.id
        assert session.exec(select(AgentConversation)).all() == [first]
