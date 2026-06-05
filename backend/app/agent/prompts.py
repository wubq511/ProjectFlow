import json
import logging
import os

from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse

logger = logging.getLogger(__name__)

# Agent 读取本地文件时会搜索的目录
_AGENT_FILE_SEARCH_PATHS = [
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "backend", "data", "uploads"),
    r"D:\ProjectFlow_Agent",
]

_MAX_RESOURCE_FILE_BYTES = 8000


def _read_resource_file(file_name: str) -> str | None:
    """尝试从已知目录查找并读取资源文件内容。"""
    # 如果是绝对路径，先尝试直接读取
    if os.path.isabs(file_name) and os.path.isfile(file_name):
        try:
            with open(file_name, encoding="utf-8") as f:
                return f.read(_MAX_RESOURCE_FILE_BYTES)
        except Exception:
            pass

    # 在已知搜索目录中按文件名查找
    base = os.path.basename(file_name)  # 去掉可能的前缀路径
    for search_dir in _AGENT_FILE_SEARCH_PATHS:
        if not os.path.isdir(search_dir):
            continue
        candidate = os.path.join(search_dir, base)
        if os.path.isfile(candidate):
            try:
                with open(candidate, encoding="utf-8") as f:
                    content = f.read(_MAX_RESOURCE_FILE_BYTES)
                    logger.info("Agent read resource file: %s (%d chars)", candidate, len(content))
                    return content
            except Exception as exc:
                logger.warning("Agent could not read %s: %s", candidate, exc)
                continue

    return None


AGENT_SYSTEM_PROMPT = """You are ProjectFlow's Coordinator Agent for Chinese-speaking student teams.
IMPORTANT: Return ONLY one valid, parseable JSON object. No markdown code blocks (```json). No trailing commas. No comments. Just pure JSON ready for json.loads().
ALL user-facing text (title, content, reason, summary, description, goal, start_suggestion, completion_standard, recommendation, evidence, progress_note) MUST be written in Chinese.
CRITICAL: Never use raw IDs (user_id, task_id) in user-facing text. Always refer to members by their display name (e.g. '小林' not 'demo-user-001') and to tasks by their title (e.g. '后端 API 与数据模型' not 'demo-task-007').
Do not fabricate members, stages, tasks, assignments, projects, or IDs; use only WorkspaceState facts.
Every reason must cite concrete state: skills, hours, deadline, status, blocker, or task/stage goal.
High-impact plan changes require "requires_confirmation": true.
Keep output concise: prefer 2-5 useful items over exhaustive lists."""


OUTPUT_CONTRACT_BY_EVENT_TYPE: dict[AgentEventType, str] = {
    AgentEventType.clarify: """DirectionCardOutput JSON object:
Required keys: "problem" string, "users" string, "value" string, "deliverables" string[], "boundaries" string[], "risks" string[], "suggested_questions" string[], "reason" string, "requires_confirmation" true.
Optional enrichment keys (include when project has resources, skills, or clear unknowns): "source_summary" string, "assumptions" string[], "unknowns" string[], "mvp_boundary" object with optional "must_have" string[], "defer" string[], "out_of_scope" string[], "decision_points" string[].
Use 2-4 deliverables, boundaries, risks, and questions.""",
    AgentEventType.plan: """StagePlanOutput JSON object:
Required keys: "stages" array, "reason" string, "requires_confirmation" true.
Each stage: "name" string, "goal" string, "start_date" YYYY-MM-DD, "end_date" YYYY-MM-DD, "deliverable" string, "done_criteria" string[], "order_index" integer, "reason" string.
Return 3 lean stages within the project deadline unless current state clearly needs fewer.""",
    AgentEventType.breakdown: """TaskBreakdownOutput JSON object:
Required keys: "tasks" array, "reason" string, "requires_confirmation" true.
Each task: "stage_id" existing stage id or null, "title" string, "description" string, "priority" one of P0/P1/P2, "due_date" YYYY-MM-DD, "estimated_hours" number, "dependency_ids" existing task id array, "acceptance_criteria" string[], "can_cut" boolean, "reason" string.
Use only existing stage_id and dependency_ids from WorkspaceState.""",
    AgentEventType.assign: """AssignmentRecommendationOutput JSON object:
Required keys: "assignments" array, "reason" string, "requires_confirmation" true.
Each assignment: "task_id" existing task id, "recommended_owner_user_id" existing member id, "backup_owner_user_id" existing member id or null, "reason" string, "skill_match" string, "availability_match" string, "preference_match" string, "constraint_respected" string, "risk_note" string or null.
Recommend only existing members for existing tasks.""",
    AgentEventType.negotiate: """AssignmentNegotiationOutput JSON object:
Required keys: "from_user_id" existing member id, "desired_task_id" existing task id, "current_owner_user_id" existing member id or null, "message" string, "options" string[], "reason" string, "requires_confirmation" true.""",
    AgentEventType.push: """ActivePushOutput JSON object:
Required keys: "action_cards" array, "reason" string.
Each action card: "type" one of personal_task/team_next_step/reminder/risk_action/kickoff_tip/checkin_prompt/assignment_request, "title" string, "content" string, "reason" string, "goal" string, "start_suggestion" string, "completion_standard" string, optional "user_id" existing member id or null, optional "task_id" existing task id or null, optional "stage_id" existing stage id or null, optional "due_date" YYYY-MM-DD or null.
All text fields (title, content, reason, goal, start_suggestion, completion_standard) MUST be written in Chinese.
Create exactly 1 card for the highest-priority next action.""",
    AgentEventType.checkin: """CheckInAnalysisOutput JSON object:
Required keys: "summary" string, "task_updates" array, "risks" array, "reason" string.
Each task update: "task_id" existing task id, "user_id" existing member id, "status" one of not_started/in_progress/done/blocked, optional "progress_note", "blocker", "available_hours_change".
Each risk must use exact keys: "type" deadline/dependency/workload/scope/review/assignment/checkin, "severity" low/medium/high, "title", "description", "evidence" non-empty string array (readable Chinese sentences, not dicts or IDs), "recommendation", optional "stage_id", optional "task_id".
Do not use risk_type, mitigation, or affected_task_ids.""",
    AgentEventType.risk: """RiskAnalysisOutput JSON object:
Required keys: "risks" array, "reason" string, optional "requires_confirmation" boolean.
Each risk: "type" one of deadline/dependency/workload/scope/review/assignment/checkin, "severity" one of low/medium/high, "title" string, "description" string, "evidence" non-empty string array (readable Chinese sentences, not dicts or IDs), "recommendation" string, optional "stage_id" existing stage id or null, optional "task_id" existing task id or null.
Return up to 3 concrete risks with different types when evidence exists; otherwise return an empty risks array. Each risk must have actual evidence from task status, check-ins, deadlines, dependencies, workload, or review pressure. Do not fabricate evidence. Set requires_confirmation true when severity is high.""",
    AgentEventType.replan: """ReplanOutput JSON object:
Required keys: "before", "after", "impact" string, "stage_adjustments" array, "task_changes" array, "action_cards" array, "reason" string, "requires_confirmation" true.
Stage adjustment: "stage_id" existing stage id, optional "new_start_date", optional "new_end_date", "reason" string.
Task change: "task_id" existing task id, optional "title", "status", "owner_user_id", "due_date", "can_cut", "reason" string.
Return the smallest useful proposal: at most 1 stage_adjustment, 1 task_change, and 1 action_card. Never change finalized owners without explicit evidence and confirmation.""",
}


def _output_contract(event_type: AgentEventType) -> str:
    return OUTPUT_CONTRACT_BY_EVENT_TYPE[event_type]


def _without_none(value):
    if isinstance(value, dict):
        return {key: _without_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_without_none(item) for item in value]
    return value


def _compact_member(member, *, include_id: bool, include_interests: bool, include_name: bool = False) -> dict:
    item: dict = {
        "skills": member.skills,
        "hours": member.available_hours_per_week,
        "pref": member.role_preference,
        "limits": member.constraints,
    }
    if include_id:
        item["user_id"] = member.user_id
    if include_name:
        item["name"] = member.display_name
    if include_interests and member.interests:
        item["interests"] = member.interests
    return _without_none(item)


def _compact_workspace_state_json(event_type: AgentEventType, workspace_state: WorkspaceStateResponse) -> str:
    project = workspace_state.project
    needs_member_ids = event_type in {
        AgentEventType.assign,
        AgentEventType.negotiate,
        AgentEventType.push,
        AgentEventType.checkin,
        AgentEventType.risk,
        AgentEventType.replan,
    }
    include_member_interests = event_type in {
        AgentEventType.assign,
    }
    include_member_names = needs_member_ids  # push/checkin/risk/replan/assign: LLM needs member names for text
    payload = {
        "members": [
            _compact_member(
                member,
                include_id=needs_member_ids,
                include_name=include_member_names,
                include_interests=include_member_interests,
            )
            for member in workspace_state.members
        ],
        "project": None,
    }
    if project is not None:
        include_project_brief = event_type in {
            AgentEventType.clarify,
            AgentEventType.plan,
            AgentEventType.breakdown,
        }
        stages = project.stages
        tasks = project.tasks
        if event_type in {
            AgentEventType.assign,
            AgentEventType.breakdown,
            AgentEventType.push,
            AgentEventType.checkin,
            AgentEventType.risk,
            AgentEventType.replan,
        }:
            target_stage_id = project.current_stage_id or (stages[0].id if stages else None)
            stages = [stage for stage in stages if stage.id == target_stage_id]
            tasks = [task for task in tasks if task.stage_id == target_stage_id]
        if event_type in {
            AgentEventType.breakdown,
            AgentEventType.push,
            AgentEventType.checkin,
            AgentEventType.risk,
            AgentEventType.replan,
        }:
            direction_card = None
        elif event_type == AgentEventType.plan:
            direction_card = project.direction_card
        elif project.direction_card:
            direction_card = {
                "problem": project.direction_card.get("problem"),
                "value": project.direction_card.get("value"),
                "deliverables": project.direction_card.get("deliverables"),
                "risks": project.direction_card.get("risks", [])[:2],
            }
        else:
            direction_card = None

        payload["project"] = {
            "name": project.name if include_project_brief else None,
            "idea": project.idea if include_project_brief else None,
            "deadline": project.deadline.isoformat(),
            "deliverables": project.deliverables if include_project_brief else None,
            "direction_card": direction_card,
            "status": project.status,
            "current_stage_id": project.current_stage_id,
            "stages": [
                {
                    "id": stage.id,
                    "name": stage.name,
                    "goal": stage.goal,
                    "start_date": stage.start_date.isoformat() if stage.start_date else None,
                    "end_date": stage.end_date.isoformat() if stage.end_date else None,
                    "deliverable": stage.deliverable,
                    "done_criteria": stage.done_criteria if event_type == AgentEventType.plan else [],
                    "status": stage.status,
                    "order_index": stage.order_index,
                }
                for stage in stages
            ],
            "tasks": [
                _without_none({
                    "id": task.id,
                    "stage_id": task.stage_id,
                    "title": task.title,
                    "description": task.description if event_type in {
                        AgentEventType.assign,
                        AgentEventType.breakdown,
                    } else None,
                    "status": task.status,
                    "priority": task.priority,
                    "owner_user_id": task.owner_user_id,
                    "backup_owner_user_id": task.backup_owner_user_id,
                    "due_date": task.due_date.isoformat() if task.due_date else None,
                    "estimated_hours": task.estimated_hours,
                    "dependency_ids": task.dependency_ids if event_type in {
                        AgentEventType.breakdown,
                    } else None,
                    "acceptance_criteria": task.acceptance_criteria if event_type in {
                        AgentEventType.breakdown,
                    } else None,
                    "can_cut": task.can_cut,
                    "assignment_reason": task.assignment_reason if event_type in {
                        AgentEventType.assign,
                    } else None,
                })
                for task in tasks
            ],
        }
        # Include check-in data for checkin analysis so LLM can see blockers
        if event_type == AgentEventType.checkin and project.checkin_responses:
            # Build member name + task title lookup for human-readable output
            member_names = {m.user_id: m.display_name for m in workspace_state.members}
            task_titles = {t.id: t.title for t in project.tasks}
            payload["project"]["checkin_responses"] = [
                _without_none({
                    "member_name": member_names.get(r.user_id, r.user_id),
                    "task_title": task_titles.get(r.task_id, r.task_id) if r.task_id else None,
                    "what_done": r.what_done,
                    "blocker": r.blocker,
                    "mood": r.mood_or_confidence,
                })
                for r in project.checkin_responses
            ]
        # Include project resources for events that benefit from resource context
        if event_type in {
            AgentEventType.clarify,
            AgentEventType.plan,
            AgentEventType.breakdown,
        } and project.resources:
            rich_resources = []
            for r in project.resources:
                entry: dict = {
                    "type": r.type,
                    "title": r.title,
                    "file_name": r.file_name,
                    "url": r.url,
                }
                if r.content_text:
                    entry["summary"] = r.content_text[:3000]
                elif r.type == "file_stub" and r.file_name:
                    file_content = _read_resource_file(r.file_name)
                    if file_content:
                        entry["summary"] = file_content
                rich_resources.append(_without_none(entry))
            payload["project"]["resources"] = rich_resources
    return json.dumps(
        _without_none(payload),
        ensure_ascii=False,
        separators=(",", ":"),
    )


def build_prompt_messages(
    *,
    event_type: AgentEventType,
    workspace_state: WorkspaceStateResponse,
    user_prompt: str,
) -> list[dict[str, str]]:
    # Inject current date/time/timezone info for the LLM
    current_date = workspace_state.current_date or "未知"
    current_datetime = workspace_state.current_datetime or "未知"
    timezone = workspace_state.timezone or "未知"
    time_header = (
        f"## 当前日期与时间\n"
        f"当前日期: {current_date}\n"
        f"当前时间: {current_datetime}\n"
        f"时区: {timezone}\n\n"
    )
    return [
        {"role": "system", "content": AGENT_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Event type: {event_type.value}\n\n"
                f"<time_info>\n{time_header}</time_info>\n\n"
                f"<output_schema>\n{_output_contract(event_type)}\n</output_schema>\n\n"
                f"<workspace_state>\n{_compact_workspace_state_json(event_type, workspace_state)}\n</workspace_state>\n\n"
                f"Task:\n{user_prompt}"
            ),
        },
    ]
