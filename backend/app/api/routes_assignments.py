from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.core.database import get_session
from app.core.db_utils import require_user
from app.schemas.assignment import (
    AssignmentNegotiationCreate,
    AssignmentNegotiationFromProposalCreate,
    AssignmentNegotiationRead,
    AssignmentNegotiationResolve,
    AssignmentProposalCreate,
    AssignmentProposalRead,
    AssignmentResponseCreate,
    AssignmentResponseRead,
)
from app.services.assignment_service import (
    create_assignment_negotiation,
    create_assignment_negotiation_from_proposal,
    create_assignment_proposal,
    create_assignment_response,
    finalize_assignment_proposal,
    finalize_assignment_proposals_by_stage,
    get_assignment_negotiation,
    get_assignment_proposal,
    list_assignment_negotiations_by_project,
    list_assignment_proposals_by_project,
    list_assignment_responses_by_project,
    resolve_assignment_negotiation,
)

router = APIRouter(tags=["assignments"])


@router.post("/assignment-proposals", response_model=AssignmentProposalRead, status_code=201)
def api_create_assignment_proposal(
    data: AssignmentProposalCreate,
    session: Session = Depends(get_session),
):
    try:
        return create_assignment_proposal(session, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/assignment-proposals/{proposal_id}", response_model=AssignmentProposalRead)
def api_get_assignment_proposal(
    proposal_id: str,
    session: Session = Depends(get_session),
):
    proposal = get_assignment_proposal(session, proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Assignment proposal not found")
    return proposal


@router.get("/projects/{project_id}/assignment-proposals", response_model=list[AssignmentProposalRead])
def api_list_assignment_proposals_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_assignment_proposals_by_project(session, project_id)


@router.get("/projects/{project_id}/assignment-responses", response_model=list[AssignmentResponseRead])
def api_list_assignment_responses_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_assignment_responses_by_project(session, project_id)


@router.get(
    "/projects/{project_id}/assignment-negotiations",
    response_model=list[AssignmentNegotiationRead],
)
def api_list_assignment_negotiations_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_assignment_negotiations_by_project(session, project_id)


@router.post(
    "/assignment-proposals/{proposal_id}/responses",
    response_model=AssignmentResponseRead,
    status_code=201,
)
def api_create_assignment_response(
    proposal_id: str,
    data: AssignmentResponseCreate,
    session: Session = Depends(get_session),
):
    require_user(session, data.user_id)
    try:
        return create_assignment_response(session, proposal_id, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/assignment-proposals/{proposal_id}/finalize", response_model=AssignmentProposalRead)
def api_finalize_assignment_proposal(
    proposal_id: str,
    session: Session = Depends(get_session),
):
    try:
        return finalize_assignment_proposal(session, proposal_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/stages/{stage_id}/assignments/finalize", response_model=list[AssignmentProposalRead])
def api_finalize_assignment_proposals_by_stage(
    stage_id: str,
    session: Session = Depends(get_session),
):
    try:
        return finalize_assignment_proposals_by_stage(session, stage_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post(
    "/assignment-negotiations",
    response_model=AssignmentNegotiationRead,
    status_code=201,
)
def api_create_assignment_negotiation(
    data: AssignmentNegotiationCreate,
    session: Session = Depends(get_session),
):
    try:
        return create_assignment_negotiation(session, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post(
    "/assignment-proposals/{proposal_id}/negotiations",
    response_model=AssignmentNegotiationRead,
    status_code=201,
)
def api_create_assignment_negotiation_from_proposal(
    proposal_id: str,
    data: AssignmentNegotiationFromProposalCreate,
    session: Session = Depends(get_session),
):
    try:
        return create_assignment_negotiation_from_proposal(session, proposal_id, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get(
    "/assignment-negotiations/{negotiation_id}",
    response_model=AssignmentNegotiationRead,
)
def api_get_assignment_negotiation(
    negotiation_id: str,
    session: Session = Depends(get_session),
):
    negotiation = get_assignment_negotiation(session, negotiation_id)
    if negotiation is None:
        raise HTTPException(status_code=404, detail="Assignment negotiation not found")
    return negotiation


@router.post(
    "/assignment-negotiations/{negotiation_id}/resolve",
    response_model=AssignmentNegotiationRead,
)
def api_resolve_assignment_negotiation(
    negotiation_id: str,
    data: AssignmentNegotiationResolve,
    session: Session = Depends(get_session),
):
    try:
        return resolve_assignment_negotiation(session, negotiation_id, data.resolution)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
