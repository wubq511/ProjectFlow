from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.agent_conversation import (
    AgentConversationMessageCreate,
    AgentConversationRead,
    AgentConversationTurnRead,
)
from app.services.agent_conversation_service import (
    process_conversation_message_stream,
    read_project_conversation,
)
from app.services.memory_service import validate_viewer

router = APIRouter(tags=["agent-conversations"])


@router.get("/projects/{project_id}/agent-conversation", response_model=AgentConversationRead)
def api_get_project_agent_conversation(
    project_id: str,
    session: Session = Depends(get_session),
):
    try:
        return read_project_conversation(session, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


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


@router.post("/agent/conversations/{conversation_id}/messages/stream")
def api_send_agent_conversation_message_stream(
    conversation_id: str,
    data: AgentConversationMessageCreate,
    session: Session = Depends(get_session),
):
    from app.models.agent_conversation import AgentConversation

    conversation = session.get(AgentConversation, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="对话不存在")
    viewer_user_id = _require_viewer(session, conversation.project_id, data.viewer_user_id)
    try:
        return StreamingResponse(
            process_conversation_message_stream(
                session,
                conversation_id,
                data.content,
                viewer_user_id=viewer_user_id,
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
