from typing import Any

from pydantic import BaseModel


class AgentFlowRequest(BaseModel):
    workspace_id: str
    stage_id: str | None = None


class AgentFlowRead(BaseModel):
    event_type: str
    status: str
    attempts: int
    used_fallback: bool
    output: dict[str, Any]
    created_ids: list[str] = []
    proposal_id: str | None = None
