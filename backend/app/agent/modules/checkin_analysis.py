from app.agent.modules.common import AgentModuleRequest, first_member_id, first_task_id
from app.models.enums import AgentEventType
from app.schemas.workspace_state import WorkspaceStateResponse


def _member_name(workspace_state: WorkspaceStateResponse, user_id: str) -> str:
    for m in workspace_state.members:
        if m.user_id == user_id:
            return m.display_name
    return user_id


def _task_title(workspace_state: WorkspaceStateResponse, task_id: str) -> str:
    if workspace_state.project:
        for t in workspace_state.project.tasks:
            if t.id == task_id:
                return t.title
    return task_id


def build_request(workspace_state: WorkspaceStateResponse) -> AgentModuleRequest:
    member_id = first_member_id(workspace_state)
    task_id = first_task_id(workspace_state)

    if member_id is None or task_id is None:
        return AgentModuleRequest(
            event_type=AgentEventType.checkin,
            user_prompt=(
                "Analyze task progress, blockers, deadline risk, and workload from WorkspaceState. "
                "Update status only with clear evidence. Return status quo if no real signal exists. "
                "All Chinese-facing text MUST be written in Chinese."
            ),
            fallback_payload={
                "summary": "无成员或任务可供签到分析。",
                "task_updates": [],
                "risks": [],
                "reason": "无成员或任务可供签到分析。",
            },
        )

    # Scan checkin_responses for blockers to build a smarter fallback
    has_blocker = False
    blocker_task_id = task_id
    blocker_member_id = member_id
    blocker_text = ""
    if workspace_state.project and workspace_state.project.checkin_responses:
        for resp in workspace_state.project.checkin_responses:
            if resp.blocker:
                has_blocker = True
                blocker_member_id = resp.user_id
                blocker_text = resp.blocker
                if resp.task_id:
                    blocker_task_id = resp.task_id
                break

    if has_blocker:
        member_name = _member_name(workspace_state, blocker_member_id)
        task_title = _task_title(workspace_state, blocker_task_id)
        # Truncate blocker text for title (keep description full)
        blocker_brief = blocker_text if len(blocker_text) <= 40 else blocker_text[:37] + "..."

        fallback_task_updates = [
            {
                "task_id": blocker_task_id,
                "user_id": blocker_member_id,
                "status": "blocked",
                "progress_note": f"{member_name} 签到报告阻塞，建议进入重规划确认：{blocker_text}",
                "blocker": blocker_text,
            }
        ]
        fallback_risks = [
            {
                "type": "checkin",
                "severity": "high",
                "title": f"「{task_title}」被阻塞：{blocker_brief}",
                "description": f"{member_name} 在签到中报告：{blocker_text}。建议通过重规划确认是否将任务标记为 blocked，并针对性排查。",
                "evidence": [
                    f"{member_name} 在「{task_title}」中报告阻塞：{blocker_text}"
                ],
                "recommendation": f"针对「{blocker_text}」，建议：1) 确认阻塞根因是否可独立解决；2) 若需他人协助，协调具备相关技能的成员介入；3) 若短期内无法解除，评估是否调整任务优先级或截止日期。",
                "task_id": blocker_task_id,
            }
        ]
    else:
        fallback_task_updates = []
        fallback_risks = []

    return AgentModuleRequest(
        event_type=AgentEventType.checkin,
        user_prompt=(
            "Analyze the check-in responses in WorkspaceState to identify blockers, progress, and risks.\n"
            "CRITICAL RULES:\n"
            "1. If any checkin_response has a non-empty 'blocker' field, you MUST set the corresponding task's status to 'blocked' in task_updates.\n"
            "2. Identify the task by matching the response's 'task_title' to the task list, then use the task's 'id' in the task_update's 'task_id' field.\n"
            "3. Copy the EXACT blocker text from the checkin_response into the task_update's 'blocker' field.\n"
            "4. For each blocked task, generate a risk item:\n"
            "   - type=checkin, severity=high\n"
            "   - title: 引用成员名字和任务名，如「任务名」被阻塞：阻塞摘要\n"
            "   - description: 使用成员名字（如「小张」）和任务标题（如「后端 API」），说明建议通过 replan proposal 确认任务是否 blocked\n"
            "   - evidence: [\"成员名 在「任务名」中报告阻塞：完整blocker文本\"] — 使用 member_name 和 task_title，禁止放 user_id / task_id\n"
            "   - recommendation: 根据具体阻塞内容思考针对性对策，给出 2-3 条可执行建议\n"
            "5. For responses without blockers, update task progress based on what_done content.\n"
            "6. Do not invent updates for tasks not referenced in check-in responses.\n"
            "7. ALL user-facing text MUST be written in Chinese — use member names and task titles, never raw IDs.\n"
            "8. evidence 是字符串数组，每个元素是可读中文句子，引用 member_name 和 task_title。"
        ),
        fallback_payload={
            "summary": f"签到分析：{member_name} 报告「{task_title}」存在阻塞。" if has_blocker else "签到分析：无阻塞信号，任务状态保持不变。",
            "task_updates": fallback_task_updates,
            "risks": fallback_risks,
            "reason": f"检测到阻塞：{blocker_text}" if has_blocker else "无明确信号，保持当前状态。",
        },
    )
