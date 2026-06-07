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
    process_conversation_message,
    process_conversation_message_stream,
    read_project_conversation,
)

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


@router.post(
    "/agent/conversations/{conversation_id}/messages",
    response_model=AgentConversationTurnRead,
)
def api_send_agent_conversation_message(
    conversation_id: str,
    data: AgentConversationMessageCreate,
    session: Session = Depends(get_session),
):
    try:
        return process_conversation_message(session, conversation_id, data.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/agent/conversations/{conversation_id}/messages/stream")
def api_send_agent_conversation_message_stream(
    conversation_id: str,
    data: AgentConversationMessageCreate,
    session: Session = Depends(get_session),
):
    try:
        return StreamingResponse(
            process_conversation_message_stream(session, conversation_id, data.content),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
