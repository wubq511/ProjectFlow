from collections.abc import Callable

from sqlmodel import Session

from app.agent.coordinator import CoordinatorAgent
from app.agent.output_schemas import (
    ActivePushOutput,
    AssignmentRecommendationOutput,
    CheckInAnalysisOutput,
    OUTPUT_SCHEMA_BY_EVENT_TYPE,
    RiskAnalysisOutput,
)
from app.agent.workflow import AgentRunResult
from app.models import Task
from app.models.enums import AgentEventType
from app.schemas.action_card import ActionCardCreate
from app.schemas.agent_flow import AgentFlowRead
from app.schemas.assignment import AssignmentProposalCreate
from app.schemas.risk import RiskCreate
from app.schemas.task import TaskStatusUpdateCreate
from app.schemas.workspace_state import WorkspaceStateResponse
from app.services.action_card_service import create_action_card
from app.services.assignment_service import create_assignment_proposal
from app.services.risk_service import create_risk
from app.services.task_service import create_status_update
from app.services.workspace_state_service import get_workspace_state


AgentMethod = Callable[[CoordinatorAgent, WorkspaceStateResponse], AgentRunResult]


def run_agent_flow(
    session: Session,
    workspace_id: str,
    method: AgentMethod,
) -> AgentFlowRead:
    workspace_state = get_workspace_state(session, workspace_id)
    if workspace_state is None:
        raise ValueError("Workspace not found")

    coordinator = CoordinatorAgent(session=session)
    result = method(coordinator, workspace_state)
    created_ids = _persist_agent_output(session, workspace_state, result)
    event_type = _event_type_for_output(result)

    return AgentFlowRead(
        event_type=event_type.value,
        status=result.status.value,
        attempts=result.attempts,
        used_fallback=result.used_fallback,
        output=result.output.model_dump(mode="json"),
        created_ids=created_ids,
    )


def _persist_agent_output(
    session: Session,
    workspace_state: WorkspaceStateResponse,
    result: AgentRunResult,
) -> list[str]:
    if workspace_state.project is None:
        return []
    project_id = workspace_state.project.id
    output = result.output
    created_ids: list[str] = []

    if isinstance(output, AssignmentRecommendationOutput):
        for assignment in output.assignments:
            proposal = create_assignment_proposal(
                session,
                AssignmentProposalCreate(
                    project_id=project_id,
                    stage_id=_stage_id_for_task(session, assignment.task_id),
                    task_id=assignment.task_id,
                    recommended_owner_user_id=assignment.recommended_owner_user_id,
                    backup_owner_user_id=assignment.backup_owner_user_id,
                    reason=assignment.reason,
                    risk_note=assignment.risk_note,
                    created_by_agent=True,
                ),
            )
            created_ids.append(proposal.id)

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
                    due_date=card.due_date,
                    created_by_agent=True,
                ),
            )
            created_ids.append(created.id)

    if isinstance(output, CheckInAnalysisOutput):
        for update in output.task_updates:
            status_update = create_status_update(
                session,
                TaskStatusUpdateCreate(
                    task_id=update.task_id,
                    user_id=update.user_id,
                    status=update.status,
                    progress_note=update.progress_note,
                    blocker=update.blocker,
                    available_hours_change=update.available_hours_change,
                ),
            )
            created_ids.append(status_update.id)
        created_ids.extend(_persist_risks(session, project_id, output.risks))

    if isinstance(output, RiskAnalysisOutput):
        created_ids.extend(_persist_risks(session, project_id, output.risks))

    return created_ids


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
        )
        created_ids.append(created.id)
    return created_ids


def _stage_id_for_task(session: Session, task_id: str) -> str:
    task = session.get(Task, task_id)
    if task:
        return task.stage_id
    raise ValueError(f"No stage available for task {task_id}")


def _event_type_for_output(result: AgentRunResult) -> AgentEventType:
    for event_type, schema in OUTPUT_SCHEMA_BY_EVENT_TYPE.items():
        if isinstance(result.output, schema):
            return event_type
    raise ValueError(f"Unsupported agent output type: {result.output.__class__.__name__}")
