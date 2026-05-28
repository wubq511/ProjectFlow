from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.core.database import get_session
from app.schemas.resource import ResourceCreate, ResourceRead
from app.services.resource_service import create_resource, list_resources_by_project

router = APIRouter(tags=["resources"])


@router.post("/resources", response_model=ResourceRead, status_code=201)
def api_create_resource(
    data: ResourceCreate,
    session: Session = Depends(get_session),
):
    return create_resource(session, data)


@router.get("/projects/{project_id}/resources", response_model=list[ResourceRead])
def api_list_resources_by_project(
    project_id: str,
    session: Session = Depends(get_session),
):
    return list_resources_by_project(session, project_id)
