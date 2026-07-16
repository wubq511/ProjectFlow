import json
from datetime import UTC, datetime
from typing import Any

from sqlmodel import Session, select

from app.core.db_utils import require_row
from app.models.project import Project
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMembership
from app.schemas.project import ProjectCreate, ProjectUpdate


def create_project(session: Session, data: ProjectCreate) -> Project:
    require_row(session, Workspace, data.workspace_id, "Workspace")
    require_row(session, User, data.created_by, "User")
    membership = session.exec(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == data.workspace_id,
            WorkspaceMembership.user_id == data.created_by,
        )
    ).first()
    if membership is None:
        raise ValueError("创建者必须是工作区成员")
    project = Project(
        workspace_id=data.workspace_id,
        name=data.name,
        idea=data.idea,
        deadline=data.deadline,
        deliverables=data.deliverables,
        created_by=data.created_by,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


def get_project(session: Session, project_id: str) -> Project | None:
    return session.get(Project, project_id)


def list_projects_by_workspace(session: Session, workspace_id: str) -> list[Project]:
    return list(
        session.exec(select(Project).where(Project.workspace_id == workspace_id)).all()
    )


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _first_text(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def normalize_direction_card(value: str | dict | None) -> dict | None:
    """Return the current direction-card API shape from current or legacy data."""
    if value is None:
        return None
    if isinstance(value, str):
        if not value.strip():
            return None
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, dict):
        return None

    boundaries = _string_list(value.get("boundaries"))
    if not boundaries:
        boundaries = _string_list(value.get("constraints"))
        out_of_scope = _string_list(value.get("out_of_scope"))
        boundaries.extend(
            item for item in out_of_scope if item not in boundaries
        )

    risks = _string_list(value.get("risks"))
    if not risks:
        risks = _string_list(value.get("initial_risks"))

    result = {
        "problem": _first_text(value.get("problem")),
        "users": _first_text(value.get("users"), value.get("target_users")),
        "value": _first_text(value.get("value"), value.get("core_value")),
        "deliverables": _string_list(value.get("deliverables")),
        "boundaries": boundaries,
        "risks": risks,
        "suggested_questions": _string_list(value.get("suggested_questions")),
    }

    # Preserve extended clarification fields when present
    if value.get("source_summary"):
        result["source_summary"] = _first_text(value.get("source_summary"))
    if value.get("assumptions"):
        result["assumptions"] = _string_list(value.get("assumptions"))
    if value.get("unknowns"):
        result["unknowns"] = _string_list(value.get("unknowns"))
    if value.get("mvp_boundary") and isinstance(value["mvp_boundary"], dict):
        result["mvp_boundary"] = {
            "must_have": _string_list(value["mvp_boundary"].get("must_have")),
            "defer": _string_list(value["mvp_boundary"].get("defer")),
            "out_of_scope": _string_list(value["mvp_boundary"].get("out_of_scope")),
        }
    if value.get("decision_points"):
        result["decision_points"] = _string_list(value.get("decision_points"))
    if value.get("reason"):
        result["reason"] = _first_text(value.get("reason"))

    return result


def delete_project(session: Session, project_id: str) -> None:
    """删除项目及其所有关联数据（阶段、任务、资源、风险等）。"""
    from sqlalchemy import delete as sa_delete, select
    from app.core.db_utils import require_row
    from app.models.stage import Stage
    from app.models.task import Task, TaskStatusUpdate
    from app.models.resource import ProjectResource
    from app.models.risk import Risk
    from app.models.action_card import ActionCard
    from app.models.assignment import AssignmentProposal, AssignmentResponse, AssignmentNegotiation
    from app.models.checkin import CheckInCycle, CheckInResponse
    from app.models.timeline import AgentEvent
    from app.models.agent_proposal import AgentProposal

    project = require_row(session, Project, project_id, "project")

    # ── 1. 先查出子表需要的父表 ID（父表删后就查不到了）──
    cycle_ids = session.exec(
        select(CheckInCycle.id).where(CheckInCycle.project_id == project_id)
    ).all()
    proposal_ids = session.exec(
        select(AssignmentProposal.id).where(AssignmentProposal.project_id == project_id)
    ).all()
    task_ids = session.exec(
        select(Task.id).where(Task.project_id == project_id)
    ).all()

    # ── 2. 清理上传文件（先于 DB 删除）──
    from app.services.resource_service import delete_uploaded_file_if_safe
    resources = session.exec(
        select(ProjectResource).where(ProjectResource.project_id == project_id)
    ).all()
    for r in resources:
        if r.type == "file_stub" and r.file_name:
            delete_uploaded_file_if_safe(r.file_name)

    # ── 3. 先删叶子表（无 project_id 列，通过父表 ID 关联）──
    if cycle_ids:
        session.exec(sa_delete(CheckInResponse).where(CheckInResponse.cycle_id.in_(cycle_ids)))
    if proposal_ids:
        session.exec(sa_delete(AssignmentResponse).where(AssignmentResponse.proposal_id.in_(proposal_ids)))
    if task_ids:
        session.exec(sa_delete(TaskStatusUpdate).where(TaskStatusUpdate.task_id.in_(task_ids)))

    # ── 4. 再删有 project_id 列的父表 ──
    parent_tables = [AgentProposal, AgentEvent, ActionCard, Risk,
                     CheckInCycle, AssignmentNegotiation, AssignmentProposal,
                     Task, Stage, ProjectResource]
    for model in parent_tables:
        session.exec(sa_delete(model).where(model.project_id == project_id))  # type: ignore[arg-type]

    # ── 5. 最后删项目本身 ──
    session.delete(project)
    session.commit()


def update_project(session: Session, project_id: str, data: ProjectUpdate) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise ValueError(f"Project {project_id} not found")

    update_data = data.model_dump(exclude_unset=True)
    if "direction_card" in update_data and update_data["direction_card"] is not None:
        if not isinstance(update_data["direction_card"], str):
            update_data["direction_card"] = json.dumps(
                update_data["direction_card"],
                ensure_ascii=False,
            )
    for key, value in update_data.items():
        setattr(project, key, value)
    project.updated_at = datetime.now(UTC)

    session.add(project)
    session.commit()
    session.refresh(project)
    return project
