import json

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.agent_proposal import (
    AgentProposalConfirm,
    AgentProposalRead,
    AgentProposalReject,
)
from app.services.agent_proposal_service import (
    confirm_proposal,
    get_proposal,
    list_proposals_by_project,
    reject_proposal,
)

router = APIRouter(tags=["agent-proposals"])


def _proposal_to_read(proposal) -> AgentProposalRead:
    """Convert an AgentProposal model to AgentProposalRead, parsing JSON string fields."""
    payload = proposal.payload
    if isinstance(payload, str):
        payload = json.loads(payload)
    return AgentProposalRead(
        id=proposal.id,
        project_id=proposal.project_id,
        workspace_id=proposal.workspace_id,
        proposal_type=proposal.proposal_type,
        status=proposal.status,
        agent_event_id=proposal.agent_event_id,
        payload=payload,
        confirmed_by=proposal.confirmed_by,
        confirmed_at=proposal.confirmed_at,
        rejection_reason=proposal.rejection_reason,
        created_at=proposal.created_at,
    )


@router.get("/agent-proposals", response_model=list[AgentProposalRead])
def api_list_agent_proposals(
    project_id: str = Query(...),
    proposal_type: str | None = Query(None),
    session: Session = Depends(get_session),
):
    proposals = list_proposals_by_project(session, project_id, proposal_type)
    return [_proposal_to_read(p) for p in proposals]


@router.get("/agent-proposals/{proposal_id}", response_model=AgentProposalRead)
def api_get_agent_proposal(
    proposal_id: str,
    session: Session = Depends(get_session),
):
    proposal = get_proposal(session, proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Agent proposal not found")
    return _proposal_to_read(proposal)


@router.post("/agent-proposals/{proposal_id}/confirm", response_model=AgentProposalRead)
def api_confirm_agent_proposal(
    proposal_id: str,
    data: AgentProposalConfirm,
    session: Session = Depends(get_session),
):
    try:
        proposal = confirm_proposal(session, proposal_id, data.confirmed_by)
        return _proposal_to_read(proposal)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/agent-proposals/{proposal_id}/reject", response_model=AgentProposalRead)
def api_reject_agent_proposal(
    proposal_id: str,
    data: AgentProposalReject | None = Body(default=None),
    session: Session = Depends(get_session),
):
    try:
        proposal = reject_proposal(session, proposal_id, reason=data.reason if data else None)
        return _proposal_to_read(proposal)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
