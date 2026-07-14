from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.agent_conversation import (
    AgentConversationMessageCreate,
    AgentConversationRead,
    AgentConversationSummary,
    AgentConversationTurnRead,
    ConversationCreateRequest,
    MessagePage,
)
from app.services.agent_conversation_service import (
    create_conversation,
    get_conversation,
    get_latest_accessible_conversation,
    get_messages_page,
    list_conversations,
    process_conversation_message_stream,
)
from app.services.memory_service import validate_viewer

router = APIRouter(tags=["agent-conversations"])


def _require_viewer(session: Session, project_id: str, viewer_user_id: str | None) -> str:
    """Validate viewer_user_id and map errors to 400/404."""
    if not viewer_user_id or not viewer_user_id.strip():
        raise HTTPException(status_code=400, detail="viewer_user_id 不能为空")
    try:
        validate_viewer(session, project_id=project_id, viewer_user_id=viewer_user_id)
    except ValueError as exc:
        msg = str(exc)
        if "不是" in msg and "成员" in msg:
            raise HTTPException(status_code=404, detail="项目不存在") from exc
        if "项目不存在" in msg:
            raise HTTPException(status_code=404, detail="项目不存在") from exc
        raise HTTPException(status_code=400, detail=msg) from exc
    return viewer_user_id


# ---------------------------------------------------------------------------
# List conversations
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/agent-conversations",
    response_model=list[AgentConversationSummary],
)
def api_list_conversations(
    project_id: str,
    viewer_user_id: str = Query(..., description="当前用户 ID"),
    session: Session = Depends(get_session),
):
    """List all conversations the viewer can access for a project."""
    _require_viewer(session, project_id, viewer_user_id)
    try:
        return list_conversations(session, project_id, viewer_user_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ---------------------------------------------------------------------------
# Create conversation
# ---------------------------------------------------------------------------


@router.post(
    "/projects/{project_id}/agent-conversations",
    response_model=AgentConversationRead,
)
def api_create_conversation(
    project_id: str,
    data: ConversationCreateRequest,
    session: Session = Depends(get_session),
):
    """Create a new private conversation for the viewer."""
    _require_viewer(session, project_id, data.viewer_user_id)
    try:
        conversation = create_conversation(session, project_id, data.viewer_user_id)
        return get_conversation(session, conversation.id, data.viewer_user_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ---------------------------------------------------------------------------
# Read conversation by ID
# ---------------------------------------------------------------------------


@router.get(
    "/agent/conversations/{conversation_id}",
    response_model=AgentConversationRead,
)
def api_get_conversation(
    conversation_id: str,
    viewer_user_id: str = Query(..., description="当前用户 ID"),
    session: Session = Depends(get_session),
):
    """Get conversation detail. Requires viewer validation."""
    if not viewer_user_id.strip():
        raise HTTPException(status_code=400, detail="viewer_user_id 不能为空")
    conversation = get_conversation(session, conversation_id, viewer_user_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="对话不存在")
    return conversation


# ---------------------------------------------------------------------------
# Message page with cursor pagination
# ---------------------------------------------------------------------------


@router.get(
    "/agent/conversations/{conversation_id}/messages",
    response_model=MessagePage,
)
def api_get_messages(
    conversation_id: str,
    viewer_user_id: str = Query(..., description="当前用户 ID"),
    before_created_at: datetime | None = Query(None, description="游标：此时间之前的消息"),
    before_id: str | None = Query(None, description="游标：此 ID 之前的消息"),
    session: Session = Depends(get_session),
):
    """Get messages with cursor pagination. Returns latest page by default."""
    if not viewer_user_id.strip():
        raise HTTPException(status_code=400, detail="viewer_user_id 不能为空")
    result = get_messages_page(
        session,
        conversation_id,
        viewer_user_id,
        before_created_at=before_created_at,
        before_id=before_id,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="对话不存在")
    return result


# ---------------------------------------------------------------------------
# Legacy singular endpoint — backward compatible, non-mutating
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/agent-conversation", response_model=AgentConversationRead)
def api_get_project_agent_conversation(
    project_id: str,
    viewer_user_id: str | None = Query(None, description="当前用户 ID"),
    session: Session = Depends(get_session),
):
    """Compatibility endpoint: returns latest accessible conversation.

    Requires viewer validation. Strictly read-only — does NOT create rows.
    Returns 404 when no conversation exists.
    """
    if not viewer_user_id or not viewer_user_id.strip():
        raise HTTPException(status_code=400, detail="viewer_user_id 不能为空")
    _require_viewer(session, project_id, viewer_user_id)
    try:
        result = get_latest_accessible_conversation(session, project_id, viewer_user_id)
        if result is None:
            raise HTTPException(status_code=404, detail="对话不存在")
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ---------------------------------------------------------------------------
# Deprecated non-stream endpoint
# ---------------------------------------------------------------------------


@router.post(
    "/agent/conversations/{conversation_id}/messages",
    response_model=AgentConversationTurnRead,
    deprecated=True,
)
def api_send_agent_conversation_message(
    conversation_id: str,
    data: AgentConversationMessageCreate,
    session: Session = Depends(get_session),
):
    """Deprecated — use the stream endpoint instead."""
    raise HTTPException(status_code=410, detail="非流式对话端点已废弃，请使用流式端点。")


# ---------------------------------------------------------------------------
# Stream endpoint — with stronger authorization
# ---------------------------------------------------------------------------


@router.post("/agent/conversations/{conversation_id}/messages/stream")
def api_send_agent_conversation_message_stream(
    conversation_id: str,
    data: AgentConversationMessageCreate,
    session: Session = Depends(get_session),
):
    """Stream a message to the agent.

    Requires viewer validation. Private conversations require creator.
    Team conversations require project membership.
    """
    from app.services.agent_conversation_service import check_conversation_access

    if not data.viewer_user_id or not data.viewer_user_id.strip():
        raise HTTPException(status_code=400, detail="viewer_user_id 不能为空")
    conversation = check_conversation_access(session, conversation_id, data.viewer_user_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="对话不存在")
    viewer_user_id = data.viewer_user_id

    try:
        return StreamingResponse(
            process_conversation_message_stream(
                session,
                conversation_id,
                data.content,
                viewer_user_id=viewer_user_id,
                model=data.model,
                thinking_level=data.thinking_level,
                skill=data.skill,
                slash_command=data.slash_command,
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
