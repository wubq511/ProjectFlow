from datetime import datetime
from pydantic import BaseModel

from app.models.enums import ResourceType


class ResourceCreate(BaseModel):
    project_id: str
    type: ResourceType
    title: str
    content_text: str | None = None
    file_name: str | None = None
    url: str | None = None


class ResourceRead(BaseModel):
    id: str
    project_id: str
    type: ResourceType
    title: str
    content_text: str | None
    file_name: str | None
    url: str | None
    created_at: datetime
