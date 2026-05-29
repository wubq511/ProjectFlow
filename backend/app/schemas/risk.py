from datetime import datetime

from pydantic import BaseModel

from app.models.enums import RiskSeverity, RiskStatus, RiskType


class RiskCreate(BaseModel):
    project_id: str
    stage_id: str | None = None
    task_id: str | None = None
    type: RiskType
    severity: RiskSeverity
    title: str
    description: str
    evidence: list | dict
    recommendation: str
    created_by_agent: bool = False


class RiskRead(BaseModel):
    id: str
    project_id: str
    stage_id: str | None
    task_id: str | None
    type: RiskType
    severity: RiskSeverity
    title: str
    description: str
    evidence: list | dict
    recommendation: str
    status: RiskStatus
    created_by_agent: bool
    created_at: datetime
