from collections.abc import Callable

from sqlmodel import Session, select

from app.agent.coordinator import CoordinatorAgent
from app.agent.llm_client import LLMClient
from app.agent.output_schemas import (
    ActivePushOutput,
    AssignmentNegotiationOutput,
    AssignmentRecommendationOutput,
    CheckInAnalysisOutput,
    DirectionCardOutput,
    OUTPUT_SCHEMA_BY_EVENT_TYPE,
    ReplanOutput,
    RiskAnalysisOutput,
    StagePlanOutput,
    TaskBreakdownOutput,
)
from app.agent.workflow import AgentRunResult
from app.models import AgentEvent, Task
from app.models.enums import AgentEventType
from app.schemas.action_card import ActionCardCreate
from app.schemas.agent_flow import AgentFlowRead
from app.schemas.assignment import AssignmentProposalCreate
from app.schemas.risk import RiskCreate
from app.schemas.workspace_state import WorkspaceStateResponse
from app.services.action_card_service import create_action_card
from app.services.agent_proposal_service import create_proposal
from app.services.assignment_service import create_assignment_proposal
from app.services.risk_service import create_risk
from app.services.workspace_state_service import get_workspace_state


AgentMethod = Callable[[CoordinatorAgent, WorkspaceStateResponse, str | None], AgentRunResult]


def run_agent_flow(
    session: Session,
    workspace_id: str,
    method: AgentMethod,
    *,
    project_id: str | None = None,
    user_instruction: str | None = None,
    llm_client: LLMClient | None = None,
    workspace_state: WorkspaceStateResponse | None = None,
) -> AgentFlowRead:
    if workspace_state is None:
        workspace_state = get_workspace_state(session, workspace_id, project_id=project_id)
    if workspace_state is None:
        raise ValueError("Workspace not found")

    coordinator = CoordinatorAgent(session=session, llm_client=llm_client)
    result = method(coordinator, workspace_state, user_instruction)
    created_ids, proposal_id = _persist_agent_output(session, workspace_state, result)
    event_type = _event_type_for_output(result)

    return AgentFlowRead(
        event_type=event_type.value,
        status=result.status.value,
        attempts=result.attempts,
        used_fallback=result.used_fallback,
        output=result.output.model_dump(mode="json"),
        created_ids=created_ids,
        proposal_id=proposal_id,
    )


def _persist_agent_output(
    session: Session,
    workspace_state: WorkspaceStateResponse,
    result: AgentRunResult,
) -> tuple[list[str], str | None]:
    if workspace_state.project is None:
        return [], None
    project_id = workspace_state.project.id
    output = result.output
    created_ids: list[str] = []
    proposal_id: str | None = None

    if isinstance(output, DirectionCardOutput):
        proposal_id = _create_agent_proposal(
            session, workspace_state, project_id, "clarify", output
        )

    if isinstance(output, StagePlanOutput):
        proposal_id = _create_agent_proposal(
            session, workspace_state, project_id, "plan", output
        )

    if isinstance(output, TaskBreakdownOutput):
        proposal_id = _create_agent_proposal(
            session, workspace_state, project_id, "breakdown", output
        )

    if isinstance(output, AssignmentRecommendationOutput):
        task_ids = [a.task_id for a in output.assignments]
        task_stage_map = {
            t.id: t.stage_id
            for t in session.exec(select(Task).where(Task.id.in_(task_ids))).all()
        }
        for assignment in output.assignments:
            stage_id = task_stage_map.get(assignment.task_id)
            if not stage_id:
                raise ValueError(f"No stage available for task {assignment.task_id}")
            proposal = create_assignment_proposal(
                session,
                AssignmentProposalCreate(
                    project_id=project_id,
                    stage_id=stage_id,
                    task_id=assignment.task_id,
                    recommended_owner_user_id=assignment.recommended_owner_user_id,
                    backup_owner_user_id=assignment.backup_owner_user_id,
                    reason=assignment.reason,
                    skill_match=assignment.skill_match,
                    availability_match=assignment.availability_match,
                    preference_match=assignment.preference_match,
                    constraint_respected=assignment.constraint_respected,
                    risk_note=assignment.risk_note,
                    created_by_agent=True,
                ),
                auto_commit=False,
            )
            created_ids.append(proposal.id)

    if isinstance(output, AssignmentNegotiationOutput):
        # Negotiation is timeline-only; no generic AgentProposal needed.
        pass

    if isinstance(output, ActivePushOutput):
        for card in output.action_cards:
            created = create_action_card(
                session,
                ActionCardCreate(
                    project_id=project_id,
                    stage_id=card.stage_id,
                    user_id=card.user_id,
                    task_id=card.task_id,
                    type=card.type,
                    title=card.title,
                    content=card.content,
                    reason=card.reason,
                    goal=card.goal,
                    start_suggestion=card.start_suggestion,
                    completion_standard=card.completion_standard,
                    due_date=card.due_date,
                    created_by_agent=True,
                ),
                auto_commit=False,
            )
            created_ids.append(created.id)

    if isinstance(output, CheckInAnalysisOutput):
        proposal_id = _create_replan_proposal_from_checkin_updates(
            session,
            workspace_state,
            project_id,
            output,
        )
        created_ids.extend(_persist_risks(session, project_id, output.risks))

    if isinstance(output, RiskAnalysisOutput):
        created_ids.extend(_persist_risks(session, project_id, output.risks))

    if isinstance(output, ReplanOutput):
        proposal_id = _create_agent_proposal(
            session, workspace_state, project_id, "replan", output
        )

    session.commit()
    return created_ids, proposal_id


def _persist_risks(session: Session, project_id: str, risks) -> list[str]:
    created_ids: list[str] = []
    for risk in risks:
        created = create_risk(
            session,
            RiskCreate(
                project_id=project_id,
                stage_id=risk.stage_id,
                task_id=risk.task_id,
                type=risk.type,
                severity=risk.severity,
                title=risk.title,
                description=risk.description,
                evidence=risk.evidence,
                recommendation=risk.recommendation,
                created_by_agent=True,
            ),
            auto_commit=False,
        )
        created_ids.append(created.id)
    return created_ids


def _create_replan_proposal_from_checkin_updates(
    session: Session,
    workspace_state: WorkspaceStateResponse,
    project_id: str,
    output: CheckInAnalysisOutput,
) -> str | None:
    if not output.task_updates:
        return None

    project = workspace_state.project
    task_map = {task.id: task for task in (project.tasks if project else [])}
    member_name_map = {member.user_id: member.display_name for member in workspace_state.members}
    before_items: list[dict] = []
    after_items: list[dict] = []
    task_changes: list[dict] = []

    for update in output.task_updates:
        task = task_map.get(update.task_id)
        task_title = task.title if task else "相关任务"
        member_name = member_name_map.get(update.user_id, "相关成员")
        status = update.status.value if hasattr(update.status, "value") else update.status
        current_status = task.status if task else "unknown"
        reason = _checkin_update_reason(
            member_name=member_name,
            task_title=task_title,
            status=status,
            progress_note=update.progress_note,
            blocker=update.blocker,
        )

        before_items.append(
            {
                "task": task_title,
                "current_status": current_status,
                "due_date": task.due_date.isoformat() if task and task.due_date else "未设置",
            }
        )
        after_items.append(
            {
                "task": task_title,
                "proposed_status": status,
                "reason": reason,
            }
        )
        task_changes.append(
            {
                "task_id": update.task_id,
                "status": status,
                "reason": reason,
            }
        )

    count = len(task_changes)
    replan_output = ReplanOutput.model_validate(
        {
            "before": {"task_statuses": before_items},
            "after": {"task_status_changes": after_items},
            "impact": f"建议调整 {count} 个任务状态；确认前不会修改任务状态或阶段进度。",
            "stage_adjustments": [],
            "task_changes": task_changes,
            "action_cards": [],
            "requires_confirmation": True,
            "reason": "签到分析发现任务状态变化信号，已转为待确认的计划调整草案。",
        }
    )
    return _create_agent_proposal(
        session,
        workspace_state,
        project_id,
        "replan",
        replan_output,
        event_type=AgentEventType.checkin.value,
    )


def _checkin_update_reason(
    *,
    member_name: str,
    task_title: str,
    status: str,
    progress_note: str | None,
    blocker: str | None,
) -> str:
    if blocker:
        return (
            f"{member_name} 在签到中反馈「{task_title}」受阻：{blocker}。"
            f"建议将任务状态调整为 {status}，等待人工确认后再落库。"
        )
    if progress_note:
        return (
            f"{member_name} 的签到显示「{task_title}」进展变化：{progress_note}。"
            f"建议将任务状态调整为 {status}，等待人工确认后再落库。"
        )
    return f"{member_name} 的签到显示「{task_title}」状态需要调整为 {status}，等待人工确认后再落库。"


def _create_agent_proposal(
    session: Session,
    workspace_state: WorkspaceStateResponse,
    project_id: str,
    proposal_type: str,
    output,
    *,
    event_type: str | None = None,
) -> str:
    agent_event_id = _find_latest_agent_event_id(
        session, project_id, workspace_state.workspace_id, event_type or proposal_type
    )
    proposal = create_proposal(
        session,
        project_id=project_id,
        workspace_id=workspace_state.workspace_id,
        proposal_type=proposal_type,
        agent_event_id=agent_event_id,
        payload=output.model_dump(mode="json"),
        auto_commit=False,
    )
    return proposal.id


def _find_latest_agent_event_id(
    session: Session,
    project_id: str,
    workspace_id: str,
    event_type: str,
) -> str:
    """Find the most recent AgentEvent ID for traceability."""
    from sqlmodel import select, desc

    stmt = (
        select(AgentEvent)
        .where(
            AgentEvent.project_id == project_id,
            AgentEvent.workspace_id == workspace_id,
            AgentEvent.event_type == event_type,
        )
        .order_by(desc(AgentEvent.created_at))
        .limit(1)
    )
    event = session.exec(stmt).first()
    if event is None:
        raise ValueError(f"No agent event found for {event_type}")
    return event.id


def _event_type_for_output(result: AgentRunResult) -> AgentEventType:
    for event_type, schema in OUTPUT_SCHEMA_BY_EVENT_TYPE.items():
        if isinstance(result.output, schema):
            return event_type
    raise ValueError(f"Unsupported agent output type: {result.output.__class__.__name__}")
