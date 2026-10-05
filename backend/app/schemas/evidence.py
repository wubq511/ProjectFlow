from pydantic import BaseModel, Field


class EvidenceRef(BaseModel):
    """A structured reference to persisted project state used as evidence."""

    entity_type: str = Field(min_length=1)
    entity_id: str | None = None
    field: str = Field(min_length=1)
    value: str = Field(min_length=1)
