from datetime import datetime
from pydantic import BaseModel, field_validator

from app.models.enums import ResourceType
from app.schemas.common import NonEmptyStr


class ResourceCreate(BaseModel):
    project_id: NonEmptyStr
    type: ResourceType
    title: str = "未命名资源"
    content_text: str | None = None
    file_name: str | None = None
    url: str | None = None

    @field_validator("title", mode="before")
    @classmethod
    def ensure_title(cls, v: object) -> str:
        if not isinstance(v, str) or v.strip() == "":
            return "未命名资源"
        return v

    @field_validator("content_text", "file_name", "url", mode="before")
    @classmethod
    def empty_str_to_none(cls, v: object) -> str | None:
        if not isinstance(v, str) or v.strip() == "":
            return None
        return v


class ResourceRead(BaseModel):
    id: str
    project_id: str
    type: ResourceType
    title: str
    content_text: str | None
    file_name: str | None
    url: str | None
    created_at: datetime
