from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    service: str
    app_env: str | None = None
    evaluation_instance_id: str | None = None
